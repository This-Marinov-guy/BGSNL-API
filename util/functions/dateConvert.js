import moment from 'moment';

export const MOMENT_DATE_TIME_YEAR = 'Do MMM YYYY h:mm a';
export const MOMENT_DATE_TIME = 'Do MMM h:mm a';
export const MOMENT_DATE_YEAR = 'Do MMM YYYY';
export const MOMENT_DATE = 'Do MMM';

export const formatReverseDate = (dateString) => {
  const [year, month, day] = dateString.split("-");
  const date = new Date(year, parseInt(month, 10) - 1, day);
  return moment(date).format(MOMENT_DATE_YEAR);
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
  return moment(date1).isSame(moment(date2));
}

export const formatReactPrimeDate = (date, hours = 3) => {
  const newDate = new Date(date);  
  newDate.setHours(newDate.getHours() + hours);  
  return newDate;  
}

export const calculatePurchaseAndExpireDates = (period) => {
  const today = moment();
  const futureDate = today.clone().add(period, 'months');

  const purchaseDate = today.toDate();
  const expireDate = futureDate.toDate();

  return { purchaseDate, expireDate };
};
