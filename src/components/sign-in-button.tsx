"use client";
import { useFormStatus } from "react-dom";
import { Icon } from "./icon";
export function SignInButton() {
  const { pending } = useFormStatus();
  return <button className="btn btn-primary btn-full" disabled={pending} type="submit">{pending ? <><span className="spin" />Signing in…</> : <>Open your workspace <Icon name="arrow" size={17} /></>}</button>;
}
