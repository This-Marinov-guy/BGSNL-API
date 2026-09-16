import test from "node:test";
import assert from "node:assert/strict";
import { createAccountActionsService } from "../services/backoffice/account-actions.js";

const currentTime = 1800000000000;
const actor = { _id: "board_1", roles: ["regional_board_member"], region: "groningen", status: "active" };
function fixture(overrides = {}) {
  const state = {
    target: { _id: "member_1", id: "member_1", __v: 0, roles: ["member"], status: "active", region: "groningen", name: "Member", email: "member@example.test", subscription: { id: "sub_member", customerId: "cus_member" } },
    sub: { id: "sub_member", customer: "cus_member", status: "active", current_period_end: 1900000000, cancel_at_period_end: false },
    updates: [], messages: [], reconciles: [], limits: [], leases: [], now: currentTime, reads: 0,
  };
  const model = { findById: async () => { state.reads++; return state.target; } };
  const service = createAccountActionsService({ memberModel: model, alumniModel: model,
    resolveRegion: async () => "netherlands", now: () => state.now, secret: () => "test-only-confirmation-secret",
    stripeClient: () => ({ subscriptions: {
      retrieve: async () => structuredClone(state.sub),
      update: async (...args) => { state.updates.push(args); Object.assign(state.sub, args[1]); return structuredClone(state.sub); },
    } }),
    withLease: async (key, work) => { state.leases.push(key); return work({ assertOwned: async () => {} }); },
    reconcile: async (...args) => { state.reconciles.push(args); },
    deliver: async email => { state.messages.push(email); return { success: true }; },
    limit: async (...args) => { state.limits.push(args); },
    ...overrides,
  });
  const args = { type: "member", id: "member_1", actor };
  const cancel = async () => {
    const review = await service.inspect(args);
    return service.cancel({ ...args, body: { confirmation: review.confirmation } });
  };
  return { state, service, args, cancel };
}

test("cancellation uses the selected account and schedules period-end cancellation only", async () => {
  const f = fixture();
  const result = await f.cancel();
  assert.equal(result.cancelled, true);
  assert.equal(result.syncPending, false);
  assert.equal(result.cancelAt, new Date(1900000000000).toISOString());
  assert.deepEqual(f.state.updates[0].slice(0, 2), ["sub_member", { cancel_at_period_end: true }]);
  assert.match(f.state.updates[0][2].idempotencyKey, /^board-cancel:sub_member:/);
  assert.deepEqual(f.state.leases, ["subscription:netherlands:sub_member"]);
  assert.deepEqual(f.state.reconciles, [["sub_member", "netherlands", { expectedCustomerId: "cus_member" }]]);
  assert.equal(f.state.messages.length, 0);
});

test("board aliases, national board and admins have membership action access", async () => {
  for (const role of ["board_member", "regional_board_member", "national_board_member", "society_board_member", "admin", "super_admin"]) {
    const f = fixture();
    const result = await f.service.inspect({ ...f.args, actor: { ...actor, roles: [role] } });
    assert.equal(result.canCancel, true);
    assert.equal(result.canTransfer, true);
  }
});

test("committee, support, active member and ordinary accounts cannot inspect or mutate membership", async () => {
  for (const role of ["member", "alumni", "support", "active_member", "vip", "regional_committee_member", "national_committee_member", "committee_member"]) {
    const f = fixture();
    const args = { ...f.args, actor: { ...actor, roles: [role] }, body: {} };
    for (const method of ["inspect", "cancel", "requestTransfer"]) await assert.rejects(f.service[method](args), { code: 403 });
    assert.equal(f.state.reads, 0);
    assert.equal(f.state.updates.length + f.state.messages.length, 0);
  }
});

test("regional boards cannot manage other regions or unassigned accounts", async () => {
  for (const region of ["amsterdam", "netherlands", "", undefined]) {
    const f = fixture(); f.state.target.region = region;
    await assert.rejects(f.service.inspect(f.args), { code: 403 });
    await assert.rejects(f.service.requestTransfer({ ...f.args, body: {} }), { code: 403 });
  }
  const f = fixture();
  await assert.rejects(f.service.inspect({ ...f.args, actor: { ...actor, region: "" } }), { code: 403 });
});

test("national board can act across regions but cannot manage Admin or Super Admin membership", async () => {
  const f = fixture(); f.state.target.region = "amsterdam";
  const args = { ...f.args, actor: { ...actor, roles: ["national_board_member"] } };
  assert.equal((await f.service.inspect(args)).canCancel, true);
  for (const role of ["admin", "super_admin"]) {
    f.state.target.roles = ["member", role];
    await assert.rejects(f.service.inspect(args), { code: 403 });
  }
});

test("frozen actors are blocked and only admins retain actions through billing holds", async () => {
  for (const role of ["regional_board_member", "national_board_member", "admin", "super_admin"]) {
    const f = fixture();
    await assert.rejects(f.service.inspect({ ...f.args, actor: { ...actor, roles: [role], status: "frozen" } }), { code: 403 });
    const action = f.service.inspect({ ...f.args, actor: { ...actor, roles: [role], status: "locked" } });
    if (["admin", "super_admin"].includes(role)) assert.equal((await action).canCancel, true);
    else await assert.rejects(action, { code: 403 });
  }
});

test("wrong Stripe customer or subscription is rejected before billing writes", async () => {
  for (const patch of [{ customer: "cus_other" }, { id: "sub_other" }]) {
    const f = fixture(); Object.assign(f.state.sub, patch);
    await assert.rejects(f.service.inspect(f.args), { code: 409 });
    assert.equal(f.state.updates.length, 0);
  }
});

test("ended, scheduled, pending and absent subscriptions have no cancellation action", async () => {
  for (const patch of [{ status: "canceled" }, { status: "incomplete" }, { schedule: "sub_sched" }, { pending_update: {} }, { cancel_at_period_end: true }, { cancel_at: 1900000000 }, { current_period_end: 1700000000 }]) {
    const f = fixture(); Object.assign(f.state.sub, patch);
    const result = await f.service.inspect(f.args);
    assert.equal(result.canCancel, false);
    assert.equal(result.confirmation, null);
    assert.ok(result.cancellationReason);
  }
  const f = fixture(); f.state.target.subscription = {};
  assert.equal((await f.service.inspect(f.args)).canCancel, false);
  await assert.rejects(f.cancel(), { code: 409 });
});

test("cancellation rejects tampering, expired review and changed target or billing state", async () => {
  for (const mutate of [f => { f.state.now += 16 * 60 * 1000; }, f => { f.state.target.__v++; },
    f => { f.state.target.region = "amsterdam"; }, f => { f.state.target.roles.push("national_board_member"); },
    f => { f.state.sub.current_period_end++; }]) {
    const f = fixture(); const review = await f.service.inspect(f.args); mutate(f);
    await assert.rejects(f.service.cancel({ ...f.args, body: { confirmation: review.confirmation } }));
    assert.equal(f.state.updates.length, 0);
  }
  const f = fixture(); const review = await f.service.inspect(f.args);
  for (const body of [{}, { confirmation: `${currentTime}.${"0".repeat(64)}` }, { confirmation: review.confirmation, subscriptionId: "sub_other" }]) {
    await assert.rejects(f.service.cancel({ ...f.args, body }));
  }
  await assert.rejects(f.service.cancel({ ...f.args, actor: { ...actor, _id: "board_other" }, body: { confirmation: review.confirmation } }), { code: 409 });
  assert.equal(f.state.updates.length, 0);
});

test("Stripe success with delayed DB sync still reports scheduled cancellation truthfully", async () => {
  const f = fixture({ reconcile: async () => { throw new Error("DB temporarily unavailable"); } });
  const result = await f.cancel();
  assert.equal(result.cancelled, true); assert.equal(result.syncPending, true);
  assert.equal(f.state.updates.length, 1);
});

test("transfer requests email only the stored owner and make no billing or account changes", async () => {
  for (const type of ["member", "alumni"]) {
    const f = fixture(); f.state.target.name = "<script>";
    const snapshot = structuredClone(f.state.target);
    const result = await f.service.requestTransfer({ ...f.args, type, actor: { ...actor, roles: ["national_board_member"] }, body: {} });
    const desired = type === "member" ? "alumni" : "member";
    assert.equal(result.targetType, desired);
    assert.deepEqual(f.state.messages[0].to, [{ email: "member@example.test" }]);
    assert.match(f.state.messages[0].text, new RegExp(`https://bulgariansociety.nl/user\\?transferTo=${desired}#settings`));
    assert.doesNotMatch(f.state.messages[0].html, /<script>/);
    assert.match(f.state.messages[0].html, /&lt;script&gt;/);
    assert.deepEqual(f.state.target, snapshot);
    assert.equal(f.state.updates.length + f.state.reconciles.length, 0);
    assert.equal(f.state.limits.length, 2);
    assert.ok(f.state.limits.every(([, , ttl]) => ttl > 0));
  }
});

test("forged email/plan/identity overrides and restricted targets cannot request transfers", async () => {
  const f = fixture();
  for (const body of [{ email: "attacker@example.test" }, { customerId: "cus_other" }, { priceId: "price_other" }, { targetType: "admin" }]) {
    await assert.rejects(f.service.requestTransfer({ ...f.args, body }), { code: 422 });
  }
  f.state.target.status = "suspended";
  await assert.rejects(f.service.requestTransfer({ ...f.args, body: {} }), { code: 409 });
  assert.equal(f.state.messages.length, 0);
});

test("provider failure does not claim that the transfer email was queued", async () => {
  const f = fixture({ deliver: async () => ({ success: false }) });
  await assert.rejects(f.service.requestTransfer({ ...f.args, body: {} }), { code: 503 });
  assert.equal(f.state.updates.length, 0);
});


test("unavailable Stripe does not block transfer requests or claim cancellation is possible", async () => {
  const f = fixture({ resolveRegion: async () => { throw new Error("Stripe unavailable"); } });
  const result = await f.service.inspect(f.args);
  assert.equal(result.canTransfer, true);
  assert.equal(result.canCancel, false);
  assert.equal(result.billingUnavailable, true);
  assert.equal(result.confirmation, null);
  assert.equal(result.subscription, null);
  assert.equal(f.state.updates.length + f.state.messages.length, 0);
});


test("protected membership actions require Super Admin for member and alumni accounts", async () => {
  for (const type of ["member", "alumni"]) for (const role of ["admin", "super_admin", "vip"]) {
    for (const actorRole of ["admin", "national_board_member", "regional_board_member"]) {
      const f = fixture(); f.state.target.roles = [type, role];
      const args = { ...f.args, type, actor: { ...actor, roles: [actorRole] }, body: {} };
      for (const method of ["inspect", "cancel", "requestTransfer"]) await assert.rejects(f.service[method](args), { code: 403 });
      assert.equal(f.state.updates.length + f.state.messages.length, 0);
    }
    const f = fixture(); f.state.target.roles = [type, role];
    const args = { ...f.args, type, actor: { ...actor, roles: ["super_admin"] } };
    const review = await f.service.inspect(args);
    assert.equal(review.canTransfer, true);
    assert.equal(review.canCancel, true);
    await f.service.requestTransfer({ ...args, body: {} });
    await f.service.cancel({ ...args, body: { confirmation: review.confirmation } });
    assert.equal(f.state.updates.length, 1);
    assert.equal(f.state.messages.length, 1);
  }
});


test("regional boards cannot inspect, transfer or cancel Alumni subscriptions", async () => {
  for (const role of ["regional_board_member", "board_member"]) {
    const f = fixture();
    const args = { ...f.args, type: "alumni", actor: { ...actor, roles: [role] }, body: {} };
    for (const method of ["inspect", "cancel", "requestTransfer"]) await assert.rejects(f.service[method](args), { code: 403 });
    assert.equal(f.state.reads + f.state.updates.length + f.state.messages.length, 0);
  }
});
