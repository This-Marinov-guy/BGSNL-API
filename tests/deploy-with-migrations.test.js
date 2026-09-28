import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const script = fileURLToPath(new URL("../scripts/deploy-with-migrations.sh", import.meta.url));
const docker = `#!/usr/bin/env bash
set -eu
echo "$*" >> "$TEST_COMMANDS"
if [[ "$1 $2" == 'compose --project-name' ]]; then
  case "$*" in
    *'ps -a -q bgsnl-redis')
      if [[ "$TEST_SCENARIO" != redis-missing || -f "$TEST_COMMANDS.recovered" ]]; then echo redis-container; fi ;;
    *'up -d --build --force-recreate --no-deps --wait --wait-timeout 60 bgsnl-redis')
      [[ "$TEST_SCENARIO" != redis-recovery-failure ]] || exit 45
      touch "$TEST_COMMANDS.recovered" ;;
    *) exit 99 ;;
  esac
  exit 0
fi
case "$1 $2" in
  'inspect --format')
    if [[ "$TEST_SCENARIO" == redis-stays-unhealthy ]]; then echo 'running false unhealthy'
    elif [[ -f "$TEST_COMMANDS.recovered" ]]; then echo 'running false healthy'
    else
      case "$TEST_SCENARIO" in
        redis-stopped) echo 'exited false unhealthy' ;;
        redis-unhealthy|redis-recovery-failure) echo 'running false unhealthy' ;;
        *) echo 'running false healthy' ;;
      esac
    fi ;;
  'compose build') [[ "$TEST_SCENARIO" != build-failure ]] ;;
  'compose ps') printf 'old-api\\nold-worker\\n' ;;
  'compose stop') [[ "$TEST_SCENARIO" != stop-failure ]] ;;
  'inspect -f') echo false ;;
  'compose run')
    if [[ "$*" == *'node scripts/check-redis.js' ]]; then
      [[ "$TEST_SCENARIO" != redis-connection-failure ]] || exit 46
      exit 0
    fi
    output=''
    while (( $# )); do
      if [[ "$1" == -v ]]; then shift; output=$(printf '%s' "$1" | sed 's|:/migration-output$||'); fi
      shift
    done
    echo 'migration diagnostic: injected test result'
    case "$TEST_SCENARIO" in
      rolled-back) echo rolled-back > "$output/rollback.status"; exit 42 ;;
      rollback-failed) exit 43 ;;
      success|update-failure) echo '{"status":"succeeded"}' > "$output/result.json" ;;
    esac
    ;;
  'compose up') [[ "$TEST_SCENARIO" != update-failure ]] ;;
  'compose exec') [[ "$TEST_SCENARIO" != redis-post-start-failure ]] ;;
  'start old-api') exit 0 ;;
  *) echo 'Unexpected docker command' >&2; exit 99 ;;
esac
`;

async function deploy(t, scenario) {
  const root = await mkdtemp(path.join(tmpdir(), "bgsnl-deploy-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = path.join(root, "bin");
  await mkdir(bin);
  const redisDir = path.join(root, "redis");
  await mkdir(redisDir);
  await writeFile(path.join(redisDir, "compose.yml"), "services: {}\n");
  if (scenario !== "redis-config-missing") await writeFile(path.join(redisDir, ".env"), "# fixture\n");
  for (const [name, content] of Object.entries({ docker, git: "#!/bin/sh\necho tested-revision\n", chown: "#!/bin/sh\nexit 0\n", flock: "#!/bin/sh\nexit 0\n" })) {
    await writeFile(path.join(bin, name), content, { mode: 0o700 });
  }
  const commandsFile = path.join(root, "commands");
  const logs = path.join(root, "logs");
  const result = await new Promise((resolve, reject) => {
    const child = spawn("bash", [script], {
      // eslint-disable-next-line no-process-env
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, BGSNL_COMPOSE_DIR: root,
        BGSNL_DEPLOY_LOG_DIR: logs, BGSNL_REDIS_COMPOSE_DIR: redisDir,
        BGSNL_REDIS_WAIT_SECONDS: "60", TEST_COMMANDS: commandsFile, TEST_SCENARIO: scenario },
    });
    let output = "";
    child.stdout.on("data", chunk => { output += chunk; });
    child.stderr.on("data", chunk => { output += chunk; });
    child.on("error", reject); child.on("close", code => resolve({ code, output }));
  });
  const runDir = (await readdir(logs)).find(name => name.startsWith("run-"));
  return { ...result, commands: (await readFile(commandsFile, "utf8").catch(() => "")).trim().split("\n").filter(Boolean),
    log: await readFile(path.join(logs, runDir, "deploy.log"), "utf8") };
}

test("deployment builds, stops writers, passes all migrations, then updates without rebuilding", async t => {
  const result = await deploy(t, "success");
  assert.equal(result.code, 0, result.output);
  const order = result.commands.map(line => line.split(" ").slice(0, 2).join(" "));
  assert.deepEqual(order, ["compose --project-name", "inspect --format", "compose build", "compose run", "compose run", "compose ps", "compose stop", "inspect -f", "inspect -f", "compose run", "compose up", "compose exec", "compose exec"]);
  assert.ok(result.commands.includes("compose up -d --no-build bgsnl-api bgsnl-worker"));
  assert.ok(result.commands.some(line => line.includes("--writers-stopped")));
  assert.ok(!result.commands.some(line => line.includes("--force-recreate")));
});

test("failed migrations with confirmed rollback restart exact previous containers and block update", async t => {
  const result = await deploy(t, "rolled-back");
  assert.equal(result.code, 42, result.output);
  assert.equal(result.commands.at(-1), "start old-api old-worker");
  assert.ok(!result.commands.some(line => line.startsWith("compose up")));
  assert.match(result.log, /migration diagnostic: injected test result/);
  assert.match(result.log, /Deployment FAILED/);
});

test("unconfirmed rollback leaves writers stopped and logs recovery requirement", async t => {
  const result = await deploy(t, "rollback-failed");
  assert.equal(result.code, 43, result.output);
  assert.ok(!result.commands.some(line => /^(start|compose up)/.test(line)));
  assert.match(result.log, /rollback is not confirmed/);
});

test("image build failure leaves original services untouched", async t => {
  const result = await deploy(t, "build-failure");
  assert.notEqual(result.code, 0);
  assert.equal(result.commands.at(-1), "compose build bgsnl-api bgsnl-worker");
  assert.ok(!result.commands.some(line => /^compose (stop|run|up)/.test(line)));
});

test("failure to stop writers blocks migrations and restarts the previous services", async t => {
  const result = await deploy(t, "stop-failure");
  assert.notEqual(result.code, 0);
  assert.ok(!result.commands.some(line => line.includes("--writers-stopped") || line.startsWith("compose up")));
  assert.equal(result.commands.at(-1), "start old-api old-worker");
});

test("failure to start the new image does not restart incompatible old images after committed migrations", async t => {
  const result = await deploy(t, "update-failure");
  assert.notEqual(result.code, 0);
  assert.ok(!result.commands.some(line => line.startsWith("start ")));
  assert.match(result.log, /Deployment FAILED/);
});

for (const scenario of ["redis-missing", "redis-stopped", "redis-unhealthy"]) {
  test(`${scenario} is recovered before building or stopping the API`, async t => {
    const result = await deploy(t, scenario);
    assert.equal(result.code, 0, result.output);
    const recovery = result.commands.findIndex(line => line.includes("--force-recreate"));
    assert.ok(recovery >= 0);
    assert.ok(recovery < result.commands.findIndex(line => line.startsWith("compose build")));
    assert.match(result.commands[recovery], /--project-name bgsnl-storage/);
    assert.match(result.commands[recovery], /--wait --wait-timeout 60 bgsnl-redis$/);
    assert.ok(!result.commands.some(line => /down|--renew-anon-volumes|flush/i.test(line)));
  });
}

for (const scenario of ["redis-config-missing", "redis-recovery-failure", "redis-stays-unhealthy", "redis-connection-failure"]) {
  test(`${scenario} blocks migrations and leaves the running API untouched`, async t => {
    const result = await deploy(t, scenario);
    assert.notEqual(result.code, 0, result.output);
    assert.ok(!result.commands.some(line => line.startsWith("compose stop") || line.startsWith("compose up") || line.includes("--writers-stopped")));
  });
}

test("failed post-start Redis check reports failure without restarting old code after migrations", async t => {
  const result = await deploy(t, "redis-post-start-failure");
  assert.notEqual(result.code, 0, result.output);
  assert.ok(result.commands.some(line => line.startsWith("compose exec")));
  assert.ok(!result.commands.some(line => line.startsWith("start ")));
  assert.doesNotMatch(result.log, /Deployment completed/);
});
