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

  return getAsValue ? combinedDateTime.valueOf() : combinedDateTime.toLocaleString("nl-NL", { timeZone: "Europe/Amsterdam" });
}

export const addMonthsToDate = (months, date = new Date()) => {
  const result = new Date(date);
  const targetMonth = result.getMonth() + months;
  const year = result.getFullYear() + Math.floor(targetMonth / 12);
  const month = targetMonth % 12;
  result.setFullYear(year, month);

  if (result.getMonth() !== month) {
    result.setDate(0);
  }

  return result;
}

export const areDatesEqual = (date1, date2 = new Date()) => {
  const d1 = date1 instanceof Date ? date1 : new Date(date1);
  const d2 = date2 instanceof Date ? date2 : new Date(date2);

  return d1.getUTCFullYear() === d2.getUTCFullYear() &&
    d1.getUTCMonth() === d2.getUTCMonth() &&
    d1.getUTCDate() === d2.getUTCDate();
}

export const convertStringToDate = (dateString) => {
  const months = {
    jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
    jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11
  };

  const parts = dateString.split(' ');

  if (parts.length !== 3) {
    throw new Error('Invalid date format. Expected "DD MMM YYYY"');
  }

  const [day, monthStr, year] = parts;
  const month = months[monthStr.toLowerCase()];

  if (month === undefined) {
    throw new Error('Invalid month abbreviation');
  }

  const numericDay = parseInt(day, 10);
  const numericYear = parseInt(year, 10);

  if (isNaN(numericDay) || isNaN(numericYear)) {
    throw new Error('Invalid day or year');
  }

  return new Date(Date.UTC(numericYear, month, numericDay));
}

export const formatReactPrimeDate = (date, hours = 3) => {
  const newDate = new Date(date);  
  newDate.setHours(newDate.getHours() + hours);  
  return newDate;  
}