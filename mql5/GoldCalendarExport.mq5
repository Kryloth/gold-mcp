//+------------------------------------------------------------------+
//| GoldCalendarExport.mq5                                           |
//| Service: exports MT5 economic calendar history + upcoming events |
//| to Common\Files\gold_calendar.json for the gold-mcp collector.   |
//+------------------------------------------------------------------+
#property service
#property copyright "gold-mcp"
#property version   "1.00"

input string InpCurrencies     = "USD,EUR,CNY,GBP,JPY"; // Currencies to export
input int    InpMinImportance  = 1;                     // 0=none,1=low,2=moderate,3=high
input int    InpHistoryDays    = 730;                   // Days of history
input int    InpAheadDays      = 14;                    // Days of upcoming events
input int    InpIntervalSec    = 300;                   // Export interval
input string InpFileName       = "gold_calendar.json";  // Output file (Common\Files)

string JsonEscape(const string s)
  {
   string out = s;
   StringReplace(out, "\\", "\\\\");
   StringReplace(out, "\"", "\\\"");
   StringReplace(out, "\r", " ");
   StringReplace(out, "\n", " ");
   StringReplace(out, "\t", " ");
   return out;
  }

string JsonValue(const long raw)
  {
   if(raw == LONG_MIN)
      return "null";
   return DoubleToString((double)raw / 1000000.0, 6);
  }

bool ExportCalendar()
  {
   datetime now_srv = TimeTradeServer();
   if(now_srv == 0)
      now_srv = TimeCurrent();
   long gmt_offset = (long)(now_srv - TimeGMT());
   // Round to the nearest quarter hour; TimeTradeServer is extrapolated between ticks.
   gmt_offset = (long)MathRound(gmt_offset / 900.0) * 900;

   datetime from = now_srv - (datetime)InpHistoryDays * 86400;
   datetime to   = now_srv + (datetime)InpAheadDays * 86400;

   string currencies[];
   int ncur = StringSplit(InpCurrencies, ',', currencies);

   string tmp_name = InpFileName + ".tmp";
   int h = FileOpen(tmp_name, FILE_WRITE | FILE_TXT | FILE_ANSI | FILE_COMMON, 0, CP_UTF8);
   if(h == INVALID_HANDLE)
     {
      PrintFormat("GoldCalendarExport: cannot open %s, error %d", tmp_name, GetLastError());
      return false;
     }

   FileWriteString(h, "{\"generated_at_server\":" + IntegerToString((long)now_srv) +
                   ",\"gmt_offset\":" + IntegerToString(gmt_offset) +
                   ",\"from_server\":" + IntegerToString((long)from) +
                   ",\"to_server\":" + IntegerToString((long)to) +
                   ",\"values\":[");

   int written = 0;
   for(int c = 0; c < ncur; c++)
     {
      string cur = currencies[c];
      StringTrimLeft(cur);
      StringTrimRight(cur);
      if(cur == "")
         continue;

      MqlCalendarValue values[];
      ResetLastError();
      int n = CalendarValueHistory(values, from, to, NULL, cur);
      if(n <= 0)
        {
         PrintFormat("GoldCalendarExport: no values for %s (error %d)", cur, GetLastError());
         continue;
        }

      for(int i = 0; i < n; i++)
        {
         MqlCalendarEvent ev;
         if(!CalendarEventById(values[i].event_id, ev))
            continue;
         if((int)ev.importance < InpMinImportance)
            continue;
         MqlCalendarCountry country;
         string ccode = "";
         if(CalendarCountryById(ev.country_id, country))
            ccode = country.code;

         string row = StringFormat(
                         "{\"value_id\":%I64u,\"event_id\":%I64u,\"time_server\":%I64d,\"country\":\"%s\",\"currency\":\"%s\","
                         "\"name\":\"%s\",\"code\":\"%s\",\"importance\":%d,\"sector\":%d,\"unit\":\"%s\",\"multiplier\":%d,",
                         values[i].id, values[i].event_id, (long)values[i].time, JsonEscape(ccode), JsonEscape(cur),
                         JsonEscape(ev.name), JsonEscape(ev.event_code), (int)ev.importance, (int)ev.sector,
                         EnumToString(ev.unit), (int)ev.multiplier);
         row += "\"actual\":" + JsonValue(values[i].actual_value) +
                ",\"forecast\":" + JsonValue(values[i].forecast_value) +
                ",\"previous\":" + JsonValue(values[i].prev_value) +
                ",\"revised\":" + JsonValue(values[i].revised_prev_value) + "}";

         if(written > 0)
            FileWriteString(h, ",");
         FileWriteString(h, row);
         written++;
        }
     }

   FileWriteString(h, "]}");
   FileClose(h);

   if(!FileMove(tmp_name, FILE_COMMON, InpFileName, FILE_COMMON | FILE_REWRITE))
     {
      PrintFormat("GoldCalendarExport: cannot move file, error %d", GetLastError());
      return false;
     }
   PrintFormat("GoldCalendarExport: wrote %d calendar values", written);
   return true;
  }

void OnStart()
  {
   while(!IsStopped())
     {
      ExportCalendar();
      for(int s = 0; s < InpIntervalSec && !IsStopped(); s++)
         Sleep(1000);
     }
  }
//+------------------------------------------------------------------+
