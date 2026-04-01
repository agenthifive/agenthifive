import clsx from "clsx";
import Link from "@docusaurus/Link";
import useDocusaurusContext from "@docusaurus/useDocusaurusContext";
import Layout from "@theme/Layout";
import Heading from "@theme/Heading";

function HomepageHeader() {
  const { siteConfig } = useDocusaurusContext();
  return (
    <header
      className={clsx("hero hero--primary")}
      style={{ textAlign: "center", padding: "4rem 0" }}
    >
      <div className="container">
        <Heading as="h1" className="hero__title">
          {siteConfig.title}
        </Heading>
        <p className="hero__subtitle">{siteConfig.tagline}</p>
        <div style={{ display: "flex", gap: "1rem", justifyContent: "center" }}>
          <Link className="button button--secondary button--lg" to="/getting-started/">
            Get Started
          </Link>
          <Link className="button button--secondary button--lg" to="/openclaw/">
            OpenClaw Integration
          </Link>
        </div>
      </div>
    </header>
  );
}

const features = [
  {
    title: "Authority Delegation",
    description:
      "Securely delegate OAuth credentials and API access to AI agents without exposing tokens. Agents request actions; humans control permissions.",
    link: "/architecture/",
  },
  {
    title: "Policy Engine",
    description:
      "Fine-grained request evaluation, response filtering, PII redaction, and contextual guards. Firewall-model rule matching with preset templates.",
    link: "/architecture/policy-engine",
  },
  {
    title: "OpenClaw Integration",
    description:
      "Drop-in plugin for OpenClaw Gateway. Zero provider tokens stored locally. Supports Google Workspace, Microsoft Teams, and Telegram.",
    link: "/openclaw/",
  },
  {
    title: "MCP Server",
    description:
      "Expose AgentHiFive capabilities via Model Context Protocol. Works with any MCP-consuming client including Claude Code and OpenCode.",
    link: "/openclaw/mcp-server",
  },
  {
    title: "Execution Models",
    description:
      "Model A (token vending) for trusted agents, Model B (brokered proxy) for zero-trust execution with policy enforcement at the gateway.",
    link: "/architecture/execution-models",
  },
  {
    title: "TypeScript SDK",
    description:
      "Official SDK with typed client, error handling, and full contract types. Build integrations with a single npm install.",
    link: "/sdk/",
  },
];

function Feature({
  title,
  description,
  link,
}: {
  title: string;
  description: string;
  link: string;
}) {
  return (
    <div className={clsx("col col--4")} style={{ marginBottom: "2rem" }}>
      <div className="padding-horiz--md">
        <Heading as="h3">
          <Link to={link}>{title}</Link>
        </Heading>
        <p>{description}</p>
      </div>
    </div>
  );
}

export default function Home(): React.ReactElement {
  const { siteConfig } = useDocusaurusContext();
  return (
    <Layout title="Home" description={siteConfig.tagline}>
      <HomepageHeader />
      <main>
        <section style={{ padding: "2rem 0" }}>
          <div className="container">
            <div className="row">
              {features.map((props, idx) => (
                <Feature key={idx} {...props} />
              ))}
            </div>
          </div>
        </section>
      </main>
    </Layout>
  );
}
