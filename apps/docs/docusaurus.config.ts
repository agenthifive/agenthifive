import type { Config } from "@docusaurus/types";
import type * as Preset from "@docusaurus/preset-classic";

const baseUrl = process.env.DOCS_BASE_URL || "/";

const config: Config = {
  title: "AgentHiFive",
  tagline: "Authority delegation and permission control for AI agents",
  favicon: "img/logo.svg",
  url: "https://docs.agenthifive.com",
  baseUrl,
  organizationName: "agenthifive",
  projectName: "agenthifive",

  onBrokenLinks: "warn",
  onBrokenMarkdownLinks: "warn",

  i18n: {
    defaultLocale: "en",
    locales: ["en"],
  },

  presets: [
    [
      "classic",
      {
        docs: {
          routeBasePath: "/",
          sidebarPath: "./sidebars.ts",
          editUrl:
            "https://github.com/agenthifive/agenthifive/tree/main/apps/docs/",
        },
        blog: false,
        theme: {
          customCss: "./src/css/custom.css",
        },
      } satisfies Preset.Options,
    ],
  ],

  themes: [
    [
      "@easyops-cn/docusaurus-search-local",
      {
        hashed: true,
        language: ["en"],
        highlightSearchTermsOnTargetPage: true,
        explicitSearchResultPath: true,
      },
    ],
  ],

  themeConfig: {
    navbar: {
      title: "AgentHiFive",
      logo: {
        alt: "AgentHiFive Logo",
        src: "img/logo.svg",
      },
      items: [
        {
          type: "docSidebar",
          sidebarId: "docsSidebar",
          position: "left",
          label: "Docs",
        },
        {
          to: "/openclaw/",
          label: "OpenClaw Integration",
          position: "left",
        },
        {
          href: "https://app.agenthifive.com/login",
          label: "Log In",
          position: "right",
        },
        { href: "https://agenthifive.com", label: "Website", position: "right" },
      ],
    },
    footer: {
      style: "dark",
      links: [
        {
          title: "Docs",
          items: [
            { label: "Getting Started", to: "/getting-started/" },
            { label: "Architecture", to: "/architecture/" },
            { label: "API Reference", to: "/api-reference/" },
            { label: "SDK Guide", to: "/sdk/" },
          ],
        },
        {
          title: "OpenClaw",
          items: [
            { label: "Overview", to: "/openclaw/" },
            { label: "Plugin Guide", to: "/openclaw/plugin-guide" },
            { label: "MCP Server", to: "/openclaw/mcp-server" },
            { label: "Policy Guards", to: "/openclaw/policy-guards" },
          ],
        },
        {
          title: "More",
          items: [
            { label: "Website", href: "https://agenthifive.com" },
            { label: "App", href: "https://app.agenthifive.com/login" },
          ],
        },
      ],
      copyright: `Copyright ${new Date().getFullYear()} AgentHiFive. Built with Docusaurus.`,
    },
    prism: {
      additionalLanguages: ["bash", "json", "typescript", "go"],
    },
    colorMode: {
      defaultMode: "light",
      disableSwitch: false,
      respectPrefersColorScheme: true,
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
