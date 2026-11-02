// Checklist under a new-password field: each rule turns green when the password meets it.
import { PASSWORD_RULES } from "@/lib/password";
import { Icon } from "./Icon";

export function PasswordRules({ password, username = "" }: { password: string; username?: string }) {
  return (
    <ul className="pw-rules" aria-label="Password rules">
      {PASSWORD_RULES.map(r => {
        const ok = !!password && r.ok(password, username);
        return <li key={r.text} className={ok ? "ok" : ""}><Icon name={ok ? "check" : "x"} />{r.text}</li>;
      })}
    </ul>
  );
}
