import Link from "next/link";
import { signIn } from "@/app/actions/auth";
import { env } from "@/lib/env";
import { loadSample } from "@/lib/public-sample";
import { EnterButton } from "./enter-button";
import { SignInButton } from "./sign-in-button";
import { Icon } from "./icon";

export async function Landing({ error }: { error?: string }) {
	const sample = await loadSample();
	return (
		<>
			<div className="signin-layout">
				<section className="signin-story">
					<div className="eyebrow">LESS BUSYWORK. MORE GOOD CONTENT.</div>
					<h1>
						From a spark
						<br />
						to something
						<br />
						worth sharing.
					</h1>
					<p>
						Your ideas deserve more than another unfinished draft. Research,
						write, and prepare every channel in one thoughtful workspace.
					</p>
					<div className="signin-points">
						<div className="signin-point">
							<Icon name="book" size={18} />
							<div>
								<strong>Built on sources you can check</strong>
								<small>
									Review the research before the first word is written.
								</small>
							</div>
						</div>
						<div className="signin-point">
							<Icon name="grid" size={18} />
							<div>
								<strong>One article. All your channels.</strong>
								<small>Prepare LinkedIn, X, and email versions together.</small>
							</div>
						</div>
						<div className="signin-point">
							<Icon name="check" size={18} />
							<div>
								<strong>You keep the final say</strong>
								<small>
									Clear spending limits and human approval before release.
								</small>
							</div>
						</div>
					</div>
				</section>
				<section className="signin-card">
					<h2>Welcome to your studio.</h2>
					<p>Sign in to pick up where your ideas left off.</p>
					{error && (
						<div className="alert alert-error small" role="alert">
							{error}
						</div>
					)}
					<form action={signIn}>
						<div className="field">
							<label htmlFor="email">Work email</label>
							<input
								id="email"
								name="email"
								type="email"
								autoComplete="username"
								required
								maxLength={254}
								placeholder="you@company.com"
							/>
						</div>
						<div className="field">
							<label htmlFor="password">Password</label>
							<input
								id="password"
								name="password"
								type="password"
								autoComplete="current-password"
								required
								maxLength={1024}
								placeholder="Enter your password"
							/>
						</div>
						<SignInButton />
					</form>
					<div className="signin-footer">
						Need access or a password reset?
						<br />
						Contact your workspace administrator.
					</div>
					{env.app.demoLoginEnabled && (
						<div className="signin-demo">
							<EnterButton />
							<p>
								Explore the demo workspace. Delivery to real recipients is
								disabled.
							</p>
						</div>
					)}
				</section>
			</div>
			{sample && (
				<section className="guest-sample">
					<div>
						<span className="eyebrow">FROM THE STUDIO</span>
						<h3>{sample.title}</h3>
						<p className="small muted mb-0">{sample.metaDescription}</p>
					</div>
					<Link href={`/a/${sample.slug}`} className="btn">
						Read the article <Icon name="arrow" size={16} />
					</Link>
				</section>
			)}
		</>
	);
}
