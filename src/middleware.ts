import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";

/**
 * Keeps the Supabase session alive across requests.
 *
 * Server components cannot write cookies, so a token that expires mid-session
 * can only be refreshed here. Without this, a sign-in appears to work and then
 * silently stops being recognised — the user is bounced back to the landing
 * page with no explanation.
 *
 * `getUser()` is what performs the refresh: it revalidates the token with
 * Supabase and, when it has been rotated, the cookie handlers below write the
 * new one onto the outgoing response.
 */
export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  // Without configuration there is no session to refresh, and the app should
  // still render (DESIGN.md §20) rather than 500 on every request.
  if (!url || !key) return response;

  const supabase = createServerClient(url, key, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (items) => {
        for (const { name, value } of items) {
          request.cookies.set(name, value);
        }
        // A fresh response so the updated request cookies are carried through.
        response = NextResponse.next({ request });
        for (const { name, value, options } of items) {
          response.cookies.set(name, value, options);
        }
      },
    },
  });

  try {
    await supabase.auth.getUser();
  } catch {
    // A refresh failure is not a reason to block the request. The page's own
    // auth check decides what an unauthenticated visitor sees.
  }

  return response;
}

export const config = {
  matcher: [
    /**
     * Everything except static assets and image files.
     *
     * The public article permalink (/a/[slug]) is deliberately included: it
     * renders for signed-out visitors either way, and excluding it would mean
     * a signed-in reviewer's session silently expires while reading one.
     */
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
