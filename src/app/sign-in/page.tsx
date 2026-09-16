import { Suspense } from "react";
import Image from "next/image";

import { Icon } from "@/ui/icons";
import "@/ui/signin.css";
import { SignInForm } from "./SignInForm";

export default function SignInPage() {
  return (
    <div className="signin-page page">
      <StoryPanel />
      <Suspense fallback={<FormSideFallback />}>
        <SignInForm />
      </Suspense>
    </div>
  );
}

function StoryPanel() {
  return (
    <aside className="story">
      <div className="brand">
        <span className="mark">c</span>
        <div>
          CreatorOps
          <small>PARTNERSHIP WORKSPACE</small>
        </div>
      </div>
      <div className="storymain">
        <div className="eyebrow">PEOPLE. PROGRAMMES. PROGRESS.</div>
        <h2>
          Good partnerships.
          <br />
          Great work.
          <br />
          <span>One workspace.</span>
        </h2>
        <p className="intro">
          Bring your creator relationships, campaign execution, and programme insights together. Less chasing. More
          moving forward.
        </p>
        <div className="preview" aria-label="CreatorOps workflow">
          <div className="previewhead">
            <b>From first connection to real impact</b>
            <span className="tag">CREATOROPS</span>
          </div>
          <div className="journey">
            <div className="journeystep">
              <Icon name="users" />
              <b>Connect</b>
              <small>People &amp; partnerships</small>
            </div>
            <div className="journeystep">
              <Icon name="file" />
              <b>Deliver</b>
              <small>Campaigns &amp; content</small>
            </div>
            <div className="journeystep">
              <Icon name="chart" />
              <b>Understand</b>
              <small>Performance &amp; insights</small>
            </div>
          </div>
          <div className="previewfoot">
            <i className="dot" />
            Clear ownership at every step.
          </div>
        </div>
      </div>
      <div className="storyfoot">
        <span>Built around your team&rsquo;s work.</span>
        <span>CreatorOps</span>
      </div>
    </aside>
  );
}

function FormSideFallback() {
  return (
    <main className="formside">
      <div className="top">
        <div className="mobilebrand">
          <Image src="/logo.png" alt="CreatorOps" width={28} height={28} priority />
        </div>
      </div>
      <div className="formcontainer">
        <div className="formbrand">
          <Image src="/logo.png" alt="" width={28} height={28} priority />
          <span>CreatorOps</span>
        </div>
        <h1>Welcome back.</h1>
        <p className="subtitle">Sign in to your CreatorOps workspace.</p>
      </div>
    </main>
  );
}
