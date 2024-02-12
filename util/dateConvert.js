import { format } from "date-fns";

export const formatReverseDate = (dateString) => {
  const [year, month, day] = dateString.split("-");
  const date = new Date(year, parseInt(month, 10) - 1, day);
  return format(date, "dd MMM yyyy");
};
