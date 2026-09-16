"use client";

import { useRef, useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { FirebaseError } from "firebase/app";
import { signInWithEmailAndPassword } from "firebase/auth";

import { Icon } from "@/ui/icons";
import { getFirebaseAuth } from "@/lib/firebase/auth";
import { getSafeRedirectPath } from "@/lib/auth/redirect";

type FieldErrors = { email?: string; password?: string };

function messageForAuthError(error: unknown): string {
  if (error instanceof FirebaseError) {
    switch (error.code) {
      case "auth/invalid-credential":
      case "auth/invalid-email":
      case "auth/user-not-found":
      case "auth/wrong-password":
        return "Invalid email or password.";
      case "auth/user-disabled":
        return "This account has been disabled. Contact your administrator.";
      case "auth/too-many-requests":
        return "Too many attempts. Please wait a moment and try again.";
    }
  }
  return "Something went wrong. Please try again.";
}

export function SignInForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const helpDialogRef = useRef<HTMLDialogElement>(null);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [helpTitle, setHelpTitle] = useState("Account help");

  function openHelp(title: string) {
    setHelpTitle(title);
    helpDialogRef.current?.showModal();
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError("");

    const nextErrors: FieldErrors = {};
    if (!emailRef.current?.checkValidity()) nextErrors.email = "Enter a valid work email.";
    if (!passwordRef.current?.value) nextErrors.password = "Enter your password.";
    setFieldErrors(nextErrors);

    if (nextErrors.email) {
      emailRef.current?.focus();
      return;
    }
    if (nextErrors.password) {
      passwordRef.current?.focus();
      return;
    }

    setSubmitting(true);
    try {
      const auth = getFirebaseAuth();
      const credential = await signInWithEmailAndPassword(auth, email, password);
      const idToken = await credential.user.getIdToken();

      const response = await fetch("/api/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idToken }),
      });
      if (!response.ok) throw new Error("session-failed");

      const target = getSafeRedirectPath(searchParams.get("redirect"));
      router.push(target);
      router.refresh();
    } catch (error) {
      setSubmitting(false);
      setPassword("");
      setFormError(messageForAuthError(error));
    }
  }

  function clearFieldError(field: keyof FieldErrors) {
    setFieldErrors((prev) => (prev[field] ? { ...prev, [field]: undefined } : prev));
    if (formError) setFormError("");
  }

  return (
    <main className="formside">
      <div className="top">
        <div className="brand mobilebrand">
          <span className="mark">c</span>CreatorOps
        </div>
        <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <Icon name="shield" />
          Team access
        </span>
      </div>

      <div className="formcontainer">
        <div className="welcomemark">
          <Icon name="signin" />
        </div>
        <h1>Welcome back.</h1>
        <p className="subtitle">Sign in to your CreatorOps workspace.</p>

        <form noValidate onSubmit={handleSubmit}>
          <div className="field">
            <label htmlFor="email">Work email</label>
            <div className="inputwrap">
              <Icon name="mail" />
              <input
                ref={emailRef}
                type="email"
                id="email"
                name="email"
                placeholder="you@company.com"
                autoComplete="username"
                required
                aria-invalid={Boolean(fieldErrors.email)}
                aria-describedby="email-error"
                value={email}
                onChange={(event) => {
                  setEmail(event.target.value);
                  clearFieldError("email");
                }}
                disabled={submitting}
              />
            </div>
            <span className="fieldError" id="email-error">
              {fieldErrors.email}
            </span>
          </div>

          <div className="field">
            <label htmlFor="password">Password</label>
            <div className="inputwrap">
              <Icon name="lock" />
              <input
                ref={passwordRef}
                type={showPassword ? "text" : "password"}
                id="password"
                name="password"
                placeholder="Enter your password"
                autoComplete="current-password"
                required
                aria-invalid={Boolean(fieldErrors.password)}
                aria-describedby="password-error"
                value={password}
                onChange={(event) => {
                  setPassword(event.target.value);
                  clearFieldError("password");
                }}
                disabled={submitting}
              />
              <button
                type="button"
                className="eye"
                aria-label={showPassword ? "Hide password" : "Show password"}
                aria-pressed={showPassword}
                onClick={() => setShowPassword((value) => !value)}
              >
                <Icon name="eye" />
              </button>
            </div>
            <span className="fieldError" id="password-error">
              {fieldErrors.password}
            </span>
          </div>

          <div className="help">
            <button type="button" className="textbutton" onClick={() => openHelp("Password help")}>
              Forgot password?
            </button>
          </div>

          <div className="error" role="alert">
            {formError}
          </div>

          <button className="submit" type="submit" disabled={submitting}>
            <span>{submitting ? "Signing in…" : "Sign in"}</span>
            {!submitting && <Icon name="arrow" />}
          </button>
        </form>

        <div className="access">
          Need access?
          <button type="button" className="textbutton" onClick={() => openHelp("Request access")}>
            Contact your administrator
          </button>
        </div>
        <p className="fineprint">
          Use your assigned work account.
          <br />
          Your workspace access is managed by your organisation.
        </p>
      </div>
      <footer className="footer">CreatorOps &middot; Your programme, connected.</footer>

      <dialog ref={helpDialogRef} aria-labelledby="help-title">
        <h2 id="help-title">{helpTitle}</h2>
        <p>Contact your organisation&rsquo;s CreatorOps administrator for account access or a password reset link.</p>
        <button type="button" className="textbutton" onClick={() => helpDialogRef.current?.close()}>
          Got it
        </button>
      </dialog>
    </main>
  );
}
