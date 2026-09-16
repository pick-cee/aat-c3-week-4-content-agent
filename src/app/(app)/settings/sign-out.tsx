"use client";

import { useTransition } from "react";
import { signOut } from "@/app/actions/auth";

export function SignOutButton() {
  const [pending, startTransition] = useTransition();

  return (
    <button
      className="btn btn-sm"
      disabled={pending}
      onClick={() => startTransition(() => signOut())}
    >
      {pending ? <span className="spin" /> : "Sign out"}
    </button>
  );
}
