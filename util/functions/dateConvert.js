import moment from 'moment'

export const formatReverseDate = (dateString) => {
  const [year, month, day] = dateString.split("-");
  const date = new Date(year, parseInt(month, 10) - 1, day);
  return moment(date).format("D MMM YYYY");
};

export const dateConvertor = (date, time, getAsValue = false) => {
  // Ensure date is a Date object
  date = new Date(date);

  // Parse time string if it's not a Date object
  if (!(time instanceof Date)) {
    const [hours, minutes] = time.split(':').map(Number);
    time = new Date();
    time.setUTCHours(hours, minutes, 0, 0);
  }

  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  const day = date.getUTCDate();

  const hours = time.getUTCHours();
  const minutes = time.getUTCMinutes();
  const seconds = time.getUTCSeconds();
  const milliseconds = time.getUTCMilliseconds();

  const combinedDateTime = new Date(Date.UTC(year, month, day, hours, minutes, seconds, milliseconds));

  // Creating Date object
  return getAsValue ? combinedDateTime.valueOf() : combinedDateTime.toISOString();
}