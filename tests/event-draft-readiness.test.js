import test from 'node:test';
import assert from 'node:assert/strict';
import EventDraft from '../models/EventDraft.js';
import { isEventDraftReady } from '../validation/form-validators.js';

const completeDraft = () => new EventDraft({
  region: 'groningen', poster: 'https://images.example.test/poster.jpg', ticketImg: 'https://images.example.test/ticket.jpg',
  draftData: {
    title: 'Autumn dinner', region: 'groningen', date: '2027-10-10T18:00:00.000Z', location: 'Groningen',
    ticketTimer: '2027-10-10T17:00:00.000Z', ticketLimit: 100, text: 'An evening together.',
    isFree: false, isMemberFree: false, isTicketLink: false, isSaleClosed: false,
    guestPrice: 15, memberPrice: 10, activeMemberPrice: 8,
    earlyBird: { isEnabled: false }, lateBird: { isEnabled: false }, guestPromotion: { isEnabled: false }, memberPromotion: { isEnabled: false },
    addOns: { isEnabled: false, items: [] }, subEvent: null, extraInputsForm: [], promoCodes: { isEnabled: false, codes: [] },
  },
});

test('readiness defaults to false and complete saved draft data qualifies', async () => {
  const draft = completeDraft();
  assert.equal(draft.readyToPublish, false);
  assert.equal(await isEventDraftReady(draft), true);
});
test('required fields and persisted images are checked, not a client readiness claim', async () => {
  for (const field of ['title', 'date', 'location', 'ticketTimer', 'ticketLimit', 'text', 'guestPrice', 'memberPrice']) {
    const draft = completeDraft();
    draft.draftData[field] = '';
    draft.draftData.readyToPublish = true;
    assert.equal(await isEventDraftReady(draft), false, field);
  }
  for (const field of ['poster', 'ticketImg']) {
    const draft = completeDraft();
    draft[field] = undefined;
    draft.draftData[field] = 'https://untrusted.example.test/claimed.jpg';
    assert.equal(await isEventDraftReady(draft), false, field);
  }
});
test('free, member-free and external tickets follow their conditional publication rules', async () => {
  for (const type of ['free', 'member-free', 'external']) {
    const draft = completeDraft();
    draft.draftData.memberPrice = '';
    if (type === 'free') { draft.draftData.isFree = true; draft.draftData.guestPrice = ''; }
    if (type === 'member-free') draft.draftData.isMemberFree = true;
    if (type === 'external') { draft.draftData.isTicketLink = true; draft.draftData.guestPrice = ''; draft.draftData.ticketLink = 'https://tickets.example.test/event'; }
    assert.equal(await isEventDraftReady(draft), true, type);
  }
  const draft = completeDraft();
  draft.draftData.isTicketLink = true;
  assert.equal(await isEventDraftReady(draft), false);
});
test('enabled upsell, promo and custom-question requirements affect readiness', async () => {
  const invalid = [
    ['earlyBird', { isEnabled: true }], ['lateBird', { isEnabled: true, price: 12, memberPrice: 10, ticketLimit: 10 }],
    ['guestPromotion', { isEnabled: true }], ['addOns', { isEnabled: true, items: [] }],
    ['promoCodes', { isEnabled: true, codes: [] }],
    ['promoCodes', { isEnabled: true, codes: [null] }],
    ['promoCodes', { isEnabled: true, codes: [{ code: 'SAVE', discountType: 2, discount: 10, audiences: [] }] }],
    ['extraInputsForm', [{ type: 'select', placeholder: 'Meal', options: [] }]],
    ['extraImagesValidation', 'Invalid image'],
  ];
  for (const [field, value] of invalid) {
    const draft = completeDraft(); draft.draftData[field] = value;
    assert.equal(await isEventDraftReady(draft), false, field);
  }
  const draft = completeDraft();
  draft.draftData.promoCodes = { isEnabled: true, codes: [{ code: 'SAVE', discountType: 2, discount: 10, audiences: ['member'] }] };
  assert.equal(await isEventDraftReady(draft), true);
});
test('checking readiness does not mutate the stored draft values', async () => {
  const draft = completeDraft();
  const before = JSON.stringify(draft.draftData);
  await isEventDraftReady(draft);
  assert.equal(JSON.stringify(draft.draftData), before);
});
test('saving recalculates the stored flag and clears it when required data is removed', async () => {
  const { saveEventDraft } = await import('../controllers/Events/future-events-action-controller.js');
  const draft = completeDraft();
  let saves = 0;
  draft.save = async () => { saves++; return draft; };
  const res = { status() { return this; }, json(value) { return value; } };
  const request = () => ({ body: { region: 'groningen', readyToPublish: true, draftData: JSON.stringify(draft.draftData) }, user: { userId: 'member_test', region: 'groningen' }, files: {} });
  await saveEventDraft(request(), res, error => { throw error; }, draft);
  assert.equal(draft.readyToPublish, true);
  draft.draftData.location = '';
  await saveEventDraft(request(), res, error => { throw error; }, draft);
  assert.equal(draft.readyToPublish, false);
  assert.equal(saves, 2);
});

test('dashboard reads calculate readiness for existing drafts without writing back', async () => {
  const { fetchFullDataEventsList } = await import('../controllers/Events/future-events-action-controller.js');
  const { default: Event } = await import('../models/Event.js');
  const { ADMIN } = await import('../util/config/defines.js');
  const originalEventFind = Event.find;
  const originalDraftFind = EventDraft.find;
  const draft = completeDraft();
  Event.find = async () => [];
  EventDraft.find = async () => [draft];
  let payload;
  try {
    await fetchFullDataEventsList({ query: {}, user: { roles: [ADMIN] } }, { status() { return this; }, json(value) { payload = value; } }, error => { throw error; });
    assert.equal(payload.events[0].readyToPublish, true);
    assert.equal(draft.readyToPublish, false);
  } finally {
    Event.find = originalEventFind;
    EventDraft.find = originalDraftFind;
  }
});
