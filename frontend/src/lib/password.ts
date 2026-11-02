// What a strong password needs, shown while typing. The server checks the same list (PASSWORD_RULES in
// backend/auth/users.py) and has the last word.
export const MAX_PASSWORD = 12;

export const PASSWORD_RULES: { text: string; ok: (pw: string, username: string) => boolean }[] = [
  { text: "8 to 12 characters", ok: pw => pw.length >= 8 && pw.length <= MAX_PASSWORD },
  { text: "An upper-case letter (A-Z)", ok: pw => /[A-Z]/.test(pw) },
  { text: "A lower-case letter (a-z)", ok: pw => /[a-z]/.test(pw) },
  { text: "A number (0-9)", ok: pw => /[0-9]/.test(pw) },
  { text: "A special character (! @ # $ % …)", ok: pw => /[^A-Za-z0-9\s]/.test(pw) },
  { text: "No spaces", ok: pw => !/\s/.test(pw) },
  { text: "No user name inside it", ok: (pw, u) => !u || !pw.toLowerCase().includes(u.trim().toLowerCase()) },
];

export const isStrong = (pw: string, username = "") => PASSWORD_RULES.every(r => r.ok(pw, username));
