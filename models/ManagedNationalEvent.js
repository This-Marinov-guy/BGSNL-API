import mongoose from "mongoose";
import { eventSchema } from "./Event.js";

// The collection also holds historical partner registrations. Managed national
// events have the regular Event shape; legacy rows do not have a title.
export default mongoose.model("ManagedNationalEvent", eventSchema.clone(), "nonSocietyEvents");
