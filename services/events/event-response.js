const internalFields = ["emailCampaigns", "emailDeliveries", "cancellationDeliveries", "feedbackDeliveries", "feedbacks"];

export function eventResponse(value) {
  const result = { ...value };
  for (const field of internalFields) delete result[field];
  return result;
}
