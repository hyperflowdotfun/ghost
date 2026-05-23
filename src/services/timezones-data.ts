/**
 * Windows-curated timezone list (Microsoft TZ ID grouping) used by the
 * onboard picker and the web settings panel.
 *
 * `id` is a valid IANA identifier so `Intl.DateTimeFormat`, cron-parser,
 * and our existing TimezoneService accept it directly. `utcOffset` is the
 * standard-time UTC offset for that group — emitted to the LLM in lieu of
 * the IANA name so the model never sees a regional/language token.
 */

export interface TimezoneOption {
  id: string;
  label: string;
  utcOffset: string;
}

export const TIMEZONES: readonly TimezoneOption[] = [
  { id: "Etc/GMT+12", label: "(UTC-12:00) International Date Line West", utcOffset: "UTC-12" },
  { id: "Etc/GMT+11", label: "(UTC-11:00) Coordinated Universal Time-11", utcOffset: "UTC-11" },
  { id: "America/Adak", label: "(UTC-10:00) Aleutian Islands", utcOffset: "UTC-10" },
  { id: "Pacific/Honolulu", label: "(UTC-10:00) Hawaii", utcOffset: "UTC-10" },
  { id: "Pacific/Marquesas", label: "(UTC-09:30) Marquesas Islands", utcOffset: "UTC-9:30" },
  { id: "America/Anchorage", label: "(UTC-09:00) Alaska", utcOffset: "UTC-9" },
  { id: "Etc/GMT+9", label: "(UTC-09:00) Coordinated Universal Time-09", utcOffset: "UTC-9" },
  { id: "America/Tijuana", label: "(UTC-08:00) Baja California", utcOffset: "UTC-8" },
  { id: "Etc/GMT+8", label: "(UTC-08:00) Coordinated Universal Time-08", utcOffset: "UTC-8" },
  { id: "America/Los_Angeles", label: "(UTC-08:00) Pacific Time (US & Canada)", utcOffset: "UTC-8" },
  { id: "America/Phoenix", label: "(UTC-07:00) Arizona", utcOffset: "UTC-7" },
  { id: "America/Chihuahua", label: "(UTC-07:00) Chihuahua, La Paz, Mazatlan", utcOffset: "UTC-7" },
  { id: "America/Denver", label: "(UTC-07:00) Mountain Time (US & Canada)", utcOffset: "UTC-7" },
  { id: "America/Whitehorse", label: "(UTC-07:00) Yukon", utcOffset: "UTC-7" },
  { id: "America/Guatemala", label: "(UTC-06:00) Central America", utcOffset: "UTC-6" },
  { id: "America/Chicago", label: "(UTC-06:00) Central Time (US & Canada)", utcOffset: "UTC-6" },
  { id: "Pacific/Easter", label: "(UTC-06:00) Easter Island", utcOffset: "UTC-6" },
  { id: "America/Mexico_City", label: "(UTC-06:00) Guadalajara, Mexico City, Monterrey", utcOffset: "UTC-6" },
  { id: "America/Regina", label: "(UTC-06:00) Saskatchewan", utcOffset: "UTC-6" },
  { id: "America/Bogota", label: "(UTC-05:00) Bogota, Lima, Quito, Rio Branco", utcOffset: "UTC-5" },
  { id: "America/Cancun", label: "(UTC-05:00) Chetumal", utcOffset: "UTC-5" },
  { id: "America/New_York", label: "(UTC-05:00) Eastern Time (US & Canada)", utcOffset: "UTC-5" },
  { id: "America/Port-au-Prince", label: "(UTC-05:00) Haiti", utcOffset: "UTC-5" },
  { id: "America/Havana", label: "(UTC-05:00) Havana", utcOffset: "UTC-5" },
  { id: "America/Indianapolis", label: "(UTC-05:00) Indiana (East)", utcOffset: "UTC-5" },
  { id: "America/Grand_Turk", label: "(UTC-05:00) Turks and Caicos", utcOffset: "UTC-5" },
  { id: "America/Asuncion", label: "(UTC-04:00) Asuncion", utcOffset: "UTC-4" },
  { id: "America/Halifax", label: "(UTC-04:00) Atlantic Time (Canada)", utcOffset: "UTC-4" },
  { id: "America/Caracas", label: "(UTC-04:00) Caracas", utcOffset: "UTC-4" },
  { id: "America/Cuiaba", label: "(UTC-04:00) Cuiaba", utcOffset: "UTC-4" },
  { id: "America/La_Paz", label: "(UTC-04:00) Georgetown, La Paz, Manaus, San Juan", utcOffset: "UTC-4" },
  { id: "America/Santiago", label: "(UTC-04:00) Santiago", utcOffset: "UTC-4" },
  { id: "America/St_Johns", label: "(UTC-03:30) Newfoundland", utcOffset: "UTC-3:30" },
  { id: "America/Araguaina", label: "(UTC-03:00) Araguaina", utcOffset: "UTC-3" },
  { id: "America/Sao_Paulo", label: "(UTC-03:00) Brasilia", utcOffset: "UTC-3" },
  { id: "America/Cayenne", label: "(UTC-03:00) Cayenne, Fortaleza", utcOffset: "UTC-3" },
  { id: "America/Buenos_Aires", label: "(UTC-03:00) City of Buenos Aires", utcOffset: "UTC-3" },
  { id: "America/Godthab", label: "(UTC-03:00) Greenland", utcOffset: "UTC-3" },
  { id: "America/Montevideo", label: "(UTC-03:00) Montevideo", utcOffset: "UTC-3" },
  { id: "America/Punta_Arenas", label: "(UTC-03:00) Punta Arenas", utcOffset: "UTC-3" },
  { id: "America/Miquelon", label: "(UTC-03:00) Saint Pierre and Miquelon", utcOffset: "UTC-3" },
  { id: "America/Bahia", label: "(UTC-03:00) Salvador", utcOffset: "UTC-3" },
  { id: "Etc/GMT+2", label: "(UTC-02:00) Coordinated Universal Time-02", utcOffset: "UTC-2" },
  { id: "Atlantic/Azores", label: "(UTC-01:00) Azores", utcOffset: "UTC-1" },
  { id: "Atlantic/Cape_Verde", label: "(UTC-01:00) Cabo Verde Is.", utcOffset: "UTC-1" },
  { id: "Etc/UTC", label: "(UTC) Coordinated Universal Time", utcOffset: "UTC" },
  { id: "Europe/London", label: "(UTC+00:00) Dublin, Edinburgh, Lisbon, London", utcOffset: "UTC" },
  { id: "Atlantic/Reykjavik", label: "(UTC+00:00) Monrovia, Reykjavik", utcOffset: "UTC" },
  { id: "Africa/Sao_Tome", label: "(UTC+00:00) Sao Tome", utcOffset: "UTC" },
  { id: "Africa/Casablanca", label: "(UTC+01:00) Casablanca", utcOffset: "UTC+1" },
  { id: "Europe/Berlin", label: "(UTC+01:00) Amsterdam, Berlin, Bern, Rome, Stockholm, Vienna", utcOffset: "UTC+1" },
  { id: "Europe/Budapest", label: "(UTC+01:00) Belgrade, Bratislava, Budapest, Ljubljana, Prague", utcOffset: "UTC+1" },
  { id: "Europe/Paris", label: "(UTC+01:00) Brussels, Copenhagen, Madrid, Paris", utcOffset: "UTC+1" },
  { id: "Europe/Warsaw", label: "(UTC+01:00) Sarajevo, Skopje, Warsaw, Zagreb", utcOffset: "UTC+1" },
  { id: "Africa/Lagos", label: "(UTC+01:00) West Central Africa", utcOffset: "UTC+1" },
  { id: "Asia/Amman", label: "(UTC+02:00) Amman", utcOffset: "UTC+2" },
  { id: "Europe/Bucharest", label: "(UTC+02:00) Athens, Bucharest", utcOffset: "UTC+2" },
  { id: "Asia/Beirut", label: "(UTC+02:00) Beirut", utcOffset: "UTC+2" },
  { id: "Africa/Cairo", label: "(UTC+02:00) Cairo", utcOffset: "UTC+2" },
  { id: "Europe/Chisinau", label: "(UTC+02:00) Chisinau", utcOffset: "UTC+2" },
  { id: "Asia/Damascus", label: "(UTC+02:00) Damascus", utcOffset: "UTC+2" },
  { id: "Asia/Hebron", label: "(UTC+02:00) Gaza, Hebron", utcOffset: "UTC+2" },
  { id: "Africa/Johannesburg", label: "(UTC+02:00) Harare, Pretoria", utcOffset: "UTC+2" },
  { id: "Europe/Kiev", label: "(UTC+02:00) Helsinki, Kyiv, Riga, Sofia, Tallinn, Vilnius", utcOffset: "UTC+2" },
  { id: "Asia/Jerusalem", label: "(UTC+02:00) Jerusalem", utcOffset: "UTC+2" },
  { id: "Africa/Juba", label: "(UTC+02:00) Juba", utcOffset: "UTC+2" },
  { id: "Europe/Kaliningrad", label: "(UTC+02:00) Kaliningrad", utcOffset: "UTC+2" },
  { id: "Africa/Khartoum", label: "(UTC+02:00) Khartoum", utcOffset: "UTC+2" },
  { id: "Africa/Tripoli", label: "(UTC+02:00) Tripoli", utcOffset: "UTC+2" },
  { id: "Africa/Windhoek", label: "(UTC+02:00) Windhoek", utcOffset: "UTC+2" },
  { id: "Asia/Baghdad", label: "(UTC+03:00) Baghdad", utcOffset: "UTC+3" },
  { id: "Europe/Istanbul", label: "(UTC+03:00) Istanbul", utcOffset: "UTC+3" },
  { id: "Asia/Riyadh", label: "(UTC+03:00) Kuwait, Riyadh", utcOffset: "UTC+3" },
  { id: "Europe/Minsk", label: "(UTC+03:00) Minsk", utcOffset: "UTC+3" },
  { id: "Europe/Moscow", label: "(UTC+03:00) Moscow, St. Petersburg", utcOffset: "UTC+3" },
  { id: "Africa/Nairobi", label: "(UTC+03:00) Nairobi", utcOffset: "UTC+3" },
  { id: "Europe/Volgograd", label: "(UTC+03:00) Volgograd", utcOffset: "UTC+3" },
  { id: "Asia/Tehran", label: "(UTC+03:30) Tehran", utcOffset: "UTC+3:30" },
  { id: "Asia/Dubai", label: "(UTC+04:00) Abu Dhabi, Muscat", utcOffset: "UTC+4" },
  { id: "Europe/Astrakhan", label: "(UTC+04:00) Astrakhan, Ulyanovsk", utcOffset: "UTC+4" },
  { id: "Asia/Baku", label: "(UTC+04:00) Baku", utcOffset: "UTC+4" },
  { id: "Europe/Samara", label: "(UTC+04:00) Izhevsk, Samara", utcOffset: "UTC+4" },
  { id: "Indian/Mauritius", label: "(UTC+04:00) Port Louis", utcOffset: "UTC+4" },
  { id: "Europe/Saratov", label: "(UTC+04:00) Saratov", utcOffset: "UTC+4" },
  { id: "Asia/Tbilisi", label: "(UTC+04:00) Tbilisi", utcOffset: "UTC+4" },
  { id: "Asia/Yerevan", label: "(UTC+04:00) Yerevan", utcOffset: "UTC+4" },
  { id: "Asia/Kabul", label: "(UTC+04:30) Kabul", utcOffset: "UTC+4:30" },
  { id: "Asia/Tashkent", label: "(UTC+05:00) Ashgabat, Tashkent", utcOffset: "UTC+5" },
  { id: "Asia/Yekaterinburg", label: "(UTC+05:00) Ekaterinburg", utcOffset: "UTC+5" },
  { id: "Asia/Karachi", label: "(UTC+05:00) Islamabad, Karachi", utcOffset: "UTC+5" },
  { id: "Asia/Qyzylorda", label: "(UTC+05:00) Qyzylorda", utcOffset: "UTC+5" },
  { id: "Asia/Calcutta", label: "(UTC+05:30) Chennai, Kolkata, Mumbai, New Delhi", utcOffset: "UTC+5:30" },
  { id: "Asia/Colombo", label: "(UTC+05:30) Sri Jayawardenepura", utcOffset: "UTC+5:30" },
  { id: "Asia/Katmandu", label: "(UTC+05:45) Kathmandu", utcOffset: "UTC+5:45" },
  { id: "Asia/Almaty", label: "(UTC+06:00) Astana", utcOffset: "UTC+6" },
  { id: "Asia/Dhaka", label: "(UTC+06:00) Dhaka", utcOffset: "UTC+6" },
  { id: "Asia/Omsk", label: "(UTC+06:00) Omsk", utcOffset: "UTC+6" },
  { id: "Asia/Rangoon", label: "(UTC+06:30) Yangon (Rangoon)", utcOffset: "UTC+6:30" },
  { id: "Asia/Bangkok", label: "(UTC+07:00) Bangkok, Hanoi, Jakarta", utcOffset: "UTC+7" },
  { id: "Asia/Barnaul", label: "(UTC+07:00) Barnaul, Gorno-Altaysk", utcOffset: "UTC+7" },
  { id: "Asia/Hovd", label: "(UTC+07:00) Hovd", utcOffset: "UTC+7" },
  { id: "Asia/Krasnoyarsk", label: "(UTC+07:00) Krasnoyarsk", utcOffset: "UTC+7" },
  { id: "Asia/Novosibirsk", label: "(UTC+07:00) Novosibirsk", utcOffset: "UTC+7" },
  { id: "Asia/Tomsk", label: "(UTC+07:00) Tomsk", utcOffset: "UTC+7" },
  { id: "Asia/Shanghai", label: "(UTC+08:00) Beijing, Chongqing, Hong Kong, Urumqi", utcOffset: "UTC+8" },
  { id: "Asia/Irkutsk", label: "(UTC+08:00) Irkutsk", utcOffset: "UTC+8" },
  { id: "Asia/Singapore", label: "(UTC+08:00) Kuala Lumpur, Singapore", utcOffset: "UTC+8" },
  { id: "Australia/Perth", label: "(UTC+08:00) Perth", utcOffset: "UTC+8" },
  { id: "Asia/Taipei", label: "(UTC+08:00) Taipei", utcOffset: "UTC+8" },
  { id: "Asia/Ulaanbaatar", label: "(UTC+08:00) Ulaanbaatar", utcOffset: "UTC+8" },
  { id: "Australia/Eucla", label: "(UTC+08:45) Eucla", utcOffset: "UTC+8:45" },
  { id: "Asia/Chita", label: "(UTC+09:00) Chita", utcOffset: "UTC+9" },
  { id: "Asia/Tokyo", label: "(UTC+09:00) Osaka, Sapporo, Tokyo", utcOffset: "UTC+9" },
  { id: "Asia/Pyongyang", label: "(UTC+09:00) Pyongyang", utcOffset: "UTC+9" },
  { id: "Asia/Seoul", label: "(UTC+09:00) Seoul", utcOffset: "UTC+9" },
  { id: "Asia/Yakutsk", label: "(UTC+09:00) Yakutsk", utcOffset: "UTC+9" },
  { id: "Australia/Adelaide", label: "(UTC+09:30) Adelaide", utcOffset: "UTC+9:30" },
  { id: "Australia/Darwin", label: "(UTC+09:30) Darwin", utcOffset: "UTC+9:30" },
  { id: "Australia/Brisbane", label: "(UTC+10:00) Brisbane", utcOffset: "UTC+10" },
  { id: "Australia/Sydney", label: "(UTC+10:00) Canberra, Melbourne, Sydney", utcOffset: "UTC+10" },
  { id: "Pacific/Port_Moresby", label: "(UTC+10:00) Guam, Port Moresby", utcOffset: "UTC+10" },
  { id: "Australia/Hobart", label: "(UTC+10:00) Hobart", utcOffset: "UTC+10" },
  { id: "Asia/Vladivostok", label: "(UTC+10:00) Vladivostok", utcOffset: "UTC+10" },
  { id: "Australia/Lord_Howe", label: "(UTC+10:30) Lord Howe Island", utcOffset: "UTC+10:30" },
  { id: "Pacific/Bougainville", label: "(UTC+11:00) Bougainville Island", utcOffset: "UTC+11" },
  { id: "Asia/Srednekolymsk", label: "(UTC+11:00) Chokurdakh", utcOffset: "UTC+11" },
  { id: "Asia/Magadan", label: "(UTC+11:00) Magadan", utcOffset: "UTC+11" },
  { id: "Pacific/Norfolk", label: "(UTC+11:00) Norfolk Island", utcOffset: "UTC+11" },
  { id: "Asia/Sakhalin", label: "(UTC+11:00) Sakhalin", utcOffset: "UTC+11" },
  { id: "Pacific/Guadalcanal", label: "(UTC+11:00) Solomon Is., New Caledonia", utcOffset: "UTC+11" },
  { id: "Asia/Kamchatka", label: "(UTC+12:00) Anadyr, Petropavlovsk-Kamchatsky", utcOffset: "UTC+12" },
  { id: "Pacific/Auckland", label: "(UTC+12:00) Auckland, Wellington", utcOffset: "UTC+12" },
  { id: "Etc/GMT-12", label: "(UTC+12:00) Coordinated Universal Time+12", utcOffset: "UTC+12" },
  { id: "Pacific/Fiji", label: "(UTC+12:00) Fiji", utcOffset: "UTC+12" },
  { id: "Pacific/Chatham", label: "(UTC+12:45) Chatham Islands", utcOffset: "UTC+12:45" },
  { id: "Etc/GMT-13", label: "(UTC+13:00) Coordinated Universal Time+13", utcOffset: "UTC+13" },
  { id: "Pacific/Tongatapu", label: "(UTC+13:00) Nuku'alofa", utcOffset: "UTC+13" },
  { id: "Pacific/Apia", label: "(UTC+13:00) Samoa", utcOffset: "UTC+13" },
  { id: "Pacific/Kiritimati", label: "(UTC+14:00) Kiritimati Island", utcOffset: "UTC+14" },
];

/** Live UTC offset of an IANA tz ("UTC", "UTC+7", "UTC-5:30"). DST-aware. */
export function formatUtcOffset(tz: string, date: Date = new Date()): string {
  try {
    const part = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      timeZoneName: "shortOffset",
    })
      .formatToParts(date)
      .find((p) => p.type === "timeZoneName")?.value;
    if (!part) return "UTC";
    const m = part.match(/^(?:GMT|UTC)(?:([+-])(\d{1,2})(?::(\d{2}))?)?$/);
    if (!m || !m[1]) return "UTC";
    const sign = m[1];
    const h = Number(m[2]);
    const min = m[3] ? Number(m[3]) : 0;
    if (h === 0 && min === 0) return "UTC";
    return min === 0 ? `UTC${sign}${h}` : `UTC${sign}${h}:${String(min).padStart(2, "0")}`;
  } catch {
    return "UTC";
  }
}

/** Look up a TIMEZONES entry by IANA id. Returns the first match (some ids appear twice). */
export function findTimezoneById(id: string): TimezoneOption | undefined {
  return TIMEZONES.find((t) => t.id === id);
}
