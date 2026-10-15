import Event from "./Event.js";
import { createEmbeddedRecords } from "../services/storage/embedded-records.js";

export default createEmbeddedRecords({ ParentModel: Event, field: "emailCampaigns" });
