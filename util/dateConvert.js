import moment from 'moment'

export const formatReverseDate = (dateString) => {
  const [year, month, day] = dateString.split("-");
  const date = new Date(year, parseInt(month, 10) - 1, day);
  return moment(date).format("D MMM YYYY");
};
