// =====================================================================
// ARON Signage – Edge Function "feed"
// Đọc lịch Google/Outlook (ICS) hoặc Google Sheet (CSV) thay cho Tivi.
// - Tivi chỉ gửi mã nguồn (id), link bí mật nằm trong bảng sig_feeds (Tivi không đọc được)
// - Chỉ cho phép các tên miền Google/Microsoft → không thể bị lợi dụng làm proxy
// - Với lịch: CHỈ trả về giờ, tiêu đề, phòng họp (bỏ mô tả, người tham dự, link họp...)
//
// Cách triển khai: Supabase Dashboard → Edge Functions → Deploy a new function
//   → Via Editor → đặt tên: feed → dán toàn bộ file này → Deploy
//   → mở function "feed" → Details → TẮT "Verify JWT with legacy secret" (Enforce JWT) → Save
// =====================================================================
import { createClient } from "npm:@supabase/supabase-js@2";

const ALLOW = [
  /(^|\.)calendar\.google\.com$/,
  /(^|\.)outlook\.office365\.com$/,
  /(^|\.)outlook\.office\.com$/,
  /(^|\.)outlook\.live\.com$/,
  /^docs\.google\.com$/,
];
const KEEP = new Set([
  "UID", "DTSTART", "DTEND", "DURATION", "SUMMARY", "LOCATION",
  "RRULE", "EXDATE", "RECURRENCE-ID", "STATUS",
]);
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
};

const sb = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);
const cache = new Map<string, { t: number; body: string; type: string }>();

function txt(m: string, status: number) {
  return new Response(m, { status, headers: { ...cors, "content-type": "text/plain; charset=utf-8" } });
}

function slimIcs(raw: string): string {
  const lines = raw.replace(/\r?\n[ \t]/g, "").split(/\r?\n/);
  const out: string[] = [];
  const stack: string[] = [];
  for (const l of lines) {
    const up = l.toUpperCase();
    if (up.startsWith("BEGIN:")) {
      const b = up.slice(6).trim();
      stack.push(b);
      if (b === "VEVENT" || b === "VCALENDAR") out.push(`BEGIN:${b}`);
      continue;
    }
    if (up.startsWith("END:")) {
      const b = stack.pop();
      if (b === "VEVENT" || b === "VCALENDAR") out.push(`END:${b}`);
      continue;
    }
    if (stack[stack.length - 1] === "VEVENT") {
      const name = up.split(/[;:]/, 1)[0];
      if (KEEP.has(name)) out.push(l);
    }
  }
  return out.join("\r\n");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "GET") return txt("Method not allowed", 405);

  const id = new URL(req.url).searchParams.get("id") || "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return txt("id không hợp lệ", 400);
  }

  const hit = cache.get(id);
  if (hit && Date.now() - hit.t < 5 * 60_000) {
    return new Response(hit.body, { headers: { ...cors, "content-type": hit.type, "cache-control": "public, max-age=300" } });
  }

  const { data, error } = await sb.from("sig_feeds").select("kind,url").eq("id", id).maybeSingle();
  if (error || !data) return txt("Không tìm thấy nguồn dữ liệu", 404);

  let u: URL;
  try { u = new URL(String(data.url).trim().replace(/^webcal:/i, "https:")); }
  catch { return txt("URL không hợp lệ", 400); }
  if (u.protocol !== "https:" || !ALLOW.some((r) => r.test(u.hostname))) {
    return txt("Nguồn không được phép", 403);
  }

  let r: Response;
  try { r = await fetch(u, { redirect: "follow" }); }
  catch { return txt("Không kết nối được nguồn", 502); }
  if (!r.ok) return txt("Nguồn trả lỗi " + r.status, 502);

  let body = await r.text();
  if (body.length > 5_000_000) return txt("Dữ liệu quá lớn", 413);

  let type = "text/csv; charset=utf-8";
  if (data.kind === "ics") {
    body = slimIcs(body);
    type = "text/calendar; charset=utf-8";
  }

  cache.set(id, { t: Date.now(), body, type });
  return new Response(body, { headers: { ...cors, "content-type": type, "cache-control": "public, max-age=300" } });
});
