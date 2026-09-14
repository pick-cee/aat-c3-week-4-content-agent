"use client";

import { useFormStatus } from "react-dom";
import { signInAsDemo } from "@/app/actions/auth";

/**
 * One button, one account. DESIGN.md §4 keeps authoring and approval with the
 * same person here, so there is nobody to choose between.
 *
 * A plain <form action={serverAction}> rather than an onClick handler.
 * `redirect()` in a server action works by THROWING a NEXT_REDIRECT error that
 * Next catches and turns into a navigation. Calling the action from an event
 * handler and inspecting its return value swallows that throw, so the redirect
 * silently never happens and the button appears dead. The form binding lets
 * Next handle it.
 */
export function EnterButton() {
  return (
    <form action={signInAsDemo}>
      <Submit />
    </form>
  );
}

function Submit() {
  // Must be a child of the form: useFormStatus reads the enclosing form's state.
  const { pending } = useFormStatus();

  return (
    <button
      className="btn btn-primary"
      style={{ fontSize: 15, padding: "11px 22px" }}
      disabled={pending}
      type="submit"
    >
      {pending ? (
        <>
          <span className="spin" /> Signing in…
        </>
      ) : (
        "Open the workspace →"
      )}
    </button>
  );
}
