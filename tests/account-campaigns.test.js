import test from "node:test";
import assert from "node:assert/strict";
import MemberUser from "../models/MemberUser.js";
import AlumniUser from "../models/AlumniUser.js";
import { getAccountCampaign, markAccountCampaignSeen } from "../controllers/account-campaigns-controller.js";
import { ACCOUNT_CAMPAIGN_KEYS } from "../util/config/account-campaigns.js";
import userRouter from "../routes/users-routes.js";

const campaign = ACCOUNT_CAMPAIGN_KEYS[0];

for (const Model of [MemberUser, AlumniUser]) {
  test(`${Model.modelName}: missing history defaults empty; concurrent claims show once on the authenticated account`, async (t) => {
    const account = new Model({ _id: "account-owner", status: "locked" });
    assert.deepEqual([...account.campaignsSeen], []);
    let payload;
    getAccountCampaign({ account, params: { campaign } }, { json: (value) => { payload = value; } });
    assert.equal(payload.seen, false);
    t.mock.method(Model, "updateOne", async (query, update) => {
      assert.equal(query._id, "account-owner");
      assert.ok(query.status.$nin.includes("membership-migrated"));
      assert.equal(query.campaignsSeen.$ne, campaign);
      assert.equal(update.$set, undefined);
      if (account.campaignsSeen.includes(campaign)) return { modifiedCount: 0 };
      account.campaignsSeen.push(update.$addToSet.campaignsSeen);
      return { modifiedCount: 1 };
    });
    const results = [];
    const run = () => markAccountCampaignSeen({ account, params: { campaign }, body: { userId: "someone-else" } },
      { json: (value) => results.push(value) }, (error) => { throw error; });
    await Promise.all([run(), run(), run()]);
    assert.equal(results.filter((value) => value.shouldShow).length, 1);
    assert.deepEqual([...account.campaignsSeen], [campaign]);
    getAccountCampaign({ account, params: { campaign } }, { json: (value) => { payload = value; } });
    assert.equal(payload.seen, true);
  });
}

test("Version 4 uses campaignsSeen; retired fields are not in either model", () => {
  assert.ok(ACCOUNT_CAMPAIGN_KEYS.includes("whats-new-version4"));
  for (const Model of [MemberUser, AlumniUser]) {
    assert.equal(Model.schema.path("campaigns"), undefined);
    assert.equal(Model.schema.path("mmmCampaign2025.calendarImage"), undefined);
    const account = new Model({ campaignsSeen: ["whats-new-version4"] });
    getAccountCampaign({ account, params: { campaign: "whats-new-version4" } }, {
      json: (value) => assert.equal(value.seen, true),
    });
  }
});

test("campaign routes authenticate and reject unregistered campaign flags", async () => {
  for (const path of ["/campaigns/:campaign", "/campaigns/:campaign/seen"]) {
    const route = userRouter.stack.find((layer) => layer.route?.path === path).route;
    // The auth middleware is first; parameter validation precedes the handler.
    assert.equal(route.stack[0].handle.constructor.name, "AsyncFunction");
    const validator = route.stack[1].handle;
    const req = { params: { campaign: "arbitrary-db-flag" } };
    await validator.run(req);
    let status;
    route.stack.find((layer) => layer.name === "validateRequest").handle(req,
      { status: (code) => { status = code; return { json: () => {} }; } },
      () => assert.fail("Unknown campaign was accepted"));
    assert.equal(status, 422);
  }
});
