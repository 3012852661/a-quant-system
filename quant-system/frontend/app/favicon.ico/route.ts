export const dynamic = "force-static";

export function GET() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="6" fill="#0F172A"/><path d="M12 42h40" stroke="#334155" stroke-width="3"/><path d="M14 40l9-11 8 6 7-15 12 9" fill="none" stroke="#3B82F6" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><circle cx="50" cy="29" r="4" fill="#EF4444"/></svg>`;
  return new Response(svg, {
    headers: {
      "content-type": "image/svg+xml",
      "cache-control": "public, max-age=86400",
    },
  });
}
