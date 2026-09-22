import { walletCards } from "../services/wallet/cards.js";
import { walletEligible } from "../services/wallet/policy.js";

export function walletControllers(cards = walletCards) {
  const respond = (operation) => async (req, res) => {
    res.set({ "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex, nofollow", "Referrer-Policy": "no-referrer" });
    try { await operation(req, res); }
    catch { res.status(503).json({ message: "Membership card service is temporarily unavailable." }); }
  };
  return {
    availability: respond(async (req, res) => {
      const packet = await cards.own(req.account);
      res.json({ eligible: walletEligible(req.account), hasCard: !!packet, publicUrl: packet?.publicUrl || null });
    }),
    own: respond(async (req, res) => {
      const packet = await cards.own(req.account);
      res.status(packet ? 200 : 404).json(packet || { message: "Card unavailable" });
    }),
    create: respond(async (req, res) => {
      const packet = await cards.create(req.account);
      return res.status(packet ? 200 : 403).json(packet || { message: "Card unavailable" });
    }),
    revoke: respond(async (req, res) => { await cards.revoke(req.account); res.json({ revoked: true }); }),
    public: respond(async (req, res) => {
      const packet = await cards.public(req.params.token);
      res.status(packet ? 200 : 404).json(packet ? { card: packet.card, ticketImages: packet.ticketImages || [] } : { message: "Card unavailable" });
    }),
  };
}
export const wallet = walletControllers();
