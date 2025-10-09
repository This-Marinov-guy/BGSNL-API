import { IS_PROD } from "../functions/helpers.js";

export const SPREADSHEETS_ID = IS_PROD
  ? {
      groningen: {
        events: "1kyT9mBkJwl6vj8TBwe8UsFDNmgUF85dhVTihz2LnvM4",
        users: "1tSV3lF9NTWQrBam_SEt50rM91vdYR68Mx2OCe96OKKI",
      },
      rotterdam: {
        events: "1PEWOKkkrjDAuW30p2pgThQQZFQWMwO7n2gIa1KIF-i8",
        users: "1LXqEhn6--T_dl2jTvMdfwKlXGj-svoC_wdVKAupVa5Y",
      },
      leeuwarden: {
        events: "1FHWWtHW1U2na8inuf_xn2w7oK7rsSW568KmebnXTwHY",
        users: "1iyZTnHP5jxR78CzDxVBpW8_uBCwb6T7VILmvkyna4C4",
      },
      breda: {
        events: "1JPUNqtCsfINUqAA9jGBUUd-a9DnxmKpqaw9X3z5qKbs",
        users: "1qE5BJndzvjyD5U_--xOWS1YTrLVlaKqA6D-raHwxa98",
      },
      maastricht: {
        events: "1qZ3TFRFyumCr2SYVcWj_X6BGdal5-0yhzqUCxrPVZkc",
        users: "1YBdhVdEQA_8ulAx_Tkm7z-E_XsVgfJKBO6m5E9iiiXU",
      },
      leiden_hague: {
        events: "1fbQyRsfMCV085rvX_t7p1TnJ9HKSRzPDeHdZ6IFFDM0",
        users: "1O0jR44waD6__R543XyHZT-4EZhSbe6dedsv89YIPDRI",
      },
      amsterdam: {
        events: "1OmuK1f1XOrNWmiMyX1kJqvPRsWqZLHBsGthfM4IVQWw",
        users: "1Jb_wU-OSzuRA5mL-1LhvfboX2EM6jXzj-F-FMvvY6XI",
      },
      eindhoven: {
        events: "17BDzqt18QzFUBnU68pxwIO7-r6lqzx-rkvAiWyAawOo",
        users: "1nOZseFLca2qTMXOUSA_atenAKOfvqzaCk9b3cJdALNc",
      },
      netherlands: {
        events: "1beH2D2gY6AIVpqZ-qropFoktVKO91T03Qj700WBtxKk",
        users: "1iOCDGM2VLn5PNR0wyEUQkD2WMkuFAxnORzGG1iw4e1Q",
        alumni: "1iOCDGM2VLn5PNR0wyEUQkD2WMkuFAxnORzGG1iw4e1Q",
      },
    }
  : {
      groningen: {
        events: "1vJkbiMMS-UL8gEHX1W7eilSYMrFPQs_1fFQ1EVQjrZc",
        users: "1vJkbiMMS-UL8gEHX1W7eilSYMrFPQs_1fFQ1EVQjrZc",
      },
      rotterdam: {
        events: "1vJkbiMMS-UL8gEHX1W7eilSYMrFPQs_1fFQ1EVQjrZc",
        users: "1vJkbiMMS-UL8gEHX1W7eilSYMrFPQs_1fFQ1EVQjrZc",
      },
      leeuwarden: {
        events: "1vJkbiMMS-UL8gEHX1W7eilSYMrFPQs_1fFQ1EVQjrZc",
        users: "1vJkbiMMS-UL8gEHX1W7eilSYMrFPQs_1fFQ1EVQjrZc",
      },
      breda: {
        events: "1vJkbiMMS-UL8gEHX1W7eilSYMrFPQs_1fFQ1EVQjrZc",
        users: "1vJkbiMMS-UL8gEHX1W7eilSYMrFPQs_1fFQ1EVQjrZc",
      },
      maastricht: {
        events: "1vJkbiMMS-UL8gEHX1W7eilSYMrFPQs_1fFQ1EVQjrZc",
        users: "1vJkbiMMS-UL8gEHX1W7eilSYMrFPQs_1fFQ1EVQjrZc",
      },
      amsterdam: {
        events: "1vJkbiMMS-UL8gEHX1W7eilSYMrFPQs_1fFQ1EVQjrZc",
        users: "1vJkbiMMS-UL8gEHX1W7eilSYMrFPQs_1fFQ1EVQjrZc",
      },
      eindhoven: {
        events: "1vJkbiMMS-UL8gEHX1W7eilSYMrFPQs_1fFQ1EVQjrZc",
        users: "1vJkbiMMS-UL8gEHX1W7eilSYMrFPQs_1fFQ1EVQjrZc",
      },
      netherlands: {
        events: "1vJkbiMMS-UL8gEHX1W7eilSYMrFPQs_1fFQ1EVQjrZc",
        users: "1vJkbiMMS-UL8gEHX1W7eilSYMrFPQs_1fFQ1EVQjrZc",
        alumni: "1vJkbiMMS-UL8gEHX1W7eilSYMrFPQs_1fFQ1EVQjrZc",
      },
    };

// PRODUCTION POOL
export const DATA_POOL = "1juVudcUYCQk4OYcQKwxoEMa48H_WWRq9HriH0-wzXLc";
// TESTING POOL
// export const DATA_POOL = "1Y7Ew5JDG_-SfAQBalr7m_L2t2AsASG5uuH8KDBJLKWc";

export const STATISTICS_ABOUT_US_SHEET =
  "170XOaxJ-aVYNiXRplyx6R8vezDxGOR8nMCJB3O3AaRs";

export const ARTICLES_SHEET = "14Q76RuXAX0J3tX4bYA3WR2SFyyaXHAbxktIo-0tKN_E";

export const CLONE_SHEETS = {
  //amsterdam
  ["67bf7f7e46918f8ec1cc2712"]: "12hG3IQJq9A7SdWBL4n2aKBq6ddg16iQ9T2um68iBFy4",
};
