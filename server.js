import cors from "cors";
import express from "express";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const SITE_NAME = "mobileShalom";
const SITE_URL = process.env.SITE_URL || "https://mobileshalom.com";
const WP_API = `${SITE_URL}/wp-json/wp/v2`;
const PORT = Number(process.env.PORT) || 3000;
const UPSTREAM_TIMEOUT_MS = 10_000;

const NAMED_ENTITIES = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
  "&nbsp;": " ",
  "&hellip;": "...",
  "&mdash;": "-",
  "&ndash;": "-",
  "&rsquo;": "'",
  "&lsquo;": "'",
  "&rdquo;": '"',
  "&ldquo;": '"',
};

function decodeEntities(value = "") {
  return value
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&[a-z]+;/gi, (match) => NAMED_ENTITIES[match] ?? match);
}

function toPlainText(html = "") {
  const stripped = html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|blockquote)>/gi, "\n")
    .replace(/<[^>]+>/g, "");

  return decodeEntities(stripped)
    .replace(/[ \t]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function wpFetch(resource, params = {}) {
  const url = new URL(`${WP_API}/${resource}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }

  const response = await fetch(url, {
    headers: { "User-Agent": "mobileshalom-mcp" },
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`WordPress API returned ${response.status} for ${resource}`);
  }

  return response.json();
}

function formatPostSummary(post) {
  return [
    `Title: ${decodeEntities(post.title?.rendered ?? "")}`,
    `Slug: ${post.slug}`,
    `Date: ${post.date?.slice(0, 10) ?? "unknown"}`,
    `Link: ${post.link}`,
    post.excerpt?.rendered ? `Excerpt: ${toPlainText(post.excerpt.rendered)}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

function asText(value) {
  return { content: [{ type: "text", text: value }] };
}

function asError(error) {
  return {
    content: [{ type: "text", text: `Error: ${error.message}` }],
    isError: true,
  };
}

function buildServer() {
  const server = new McpServer(
    { name: "mobileshalom", version: "1.0.0" },
    {
      instructions:
        `Read-only access to the ${SITE_NAME} blog at ${SITE_URL}. ` +
        "Use search_posts to find articles by keyword, list_recent_posts to see what is new, " +
        "list_categories to browse topics, and get_post to read a full article.",
    },
  );

  server.registerTool(
    "search_posts",
    {
      title: "Search blog posts",
      description: `Search ${SITE_NAME} blog posts by keyword. Returns titles, links, dates and excerpts.`,
      inputSchema: {
        query: z.string().min(1).describe("Keyword or phrase to search for, e.g. 'shalom peace'"),
        limit: z.number().int().min(1).max(20).optional().describe("Maximum posts to return (default 5)"),
      },
    },
    async ({ query, limit = 5 }) => {
      try {
        const posts = await wpFetch("posts", {
          search: query,
          per_page: limit,
          _fields: "id,slug,title,date,link,excerpt",
        });

        if (posts.length === 0) {
          return asText(`No posts found for "${query}".`);
        }

        return asText(posts.map(formatPostSummary).join("\n\n"));
      } catch (error) {
        return asError(error);
      }
    },
  );

  server.registerTool(
    "list_recent_posts",
    {
      title: "List recent blog posts",
      description: `List the most recently published ${SITE_NAME} posts, newest first.`,
      inputSchema: {
        limit: z.number().int().min(1).max(20).optional().describe("Number of posts to return (default 10)"),
      },
    },
    async ({ limit = 10 }) => {
      try {
        const posts = await wpFetch("posts", {
          per_page: limit,
          orderby: "date",
          order: "desc",
          _fields: "id,slug,title,date,link,excerpt",
        });

        if (posts.length === 0) {
          return asText("No posts published yet.");
        }

        return asText(posts.map(formatPostSummary).join("\n\n"));
      } catch (error) {
        return asError(error);
      }
    },
  );

  server.registerTool(
    "get_post",
    {
      title: "Read a blog post",
      description: `Fetch the full text of a single ${SITE_NAME} post, by slug or numeric id.`,
      inputSchema: {
        slug: z.string().min(1).optional().describe("Post slug, e.g. 'gods-love'"),
        id: z.number().int().positive().optional().describe("Numeric post id, e.g. 46659"),
      },
    },
    async ({ slug, id }) => {
      try {
        if (!slug && !id) {
          throw new Error("Provide either a slug or an id.");
        }

        const fields = "id,slug,title,date,link,content";
        const post = id
          ? await wpFetch(`posts/${id}`, { _fields: fields })
          : (await wpFetch("posts", { slug, per_page: 1, _fields: fields }))[0];

        if (!post) {
          throw new Error(`No post found for "${slug ?? id}".`);
        }

        return asText(
          [
            decodeEntities(post.title?.rendered ?? ""),
            post.link,
            post.date?.slice(0, 10) ?? "",
            "",
            toPlainText(post.content?.rendered ?? ""),
          ].join("\n"),
        );
      } catch (error) {
        return asError(error);
      }
    },
  );

  server.registerTool(
    "list_categories",
    {
      title: "List blog categories",
      description: `List the topic categories used on the ${SITE_NAME} blog, with post counts.`,
      inputSchema: {},
    },
    async () => {
      try {
        const categories = await wpFetch("categories", {
          per_page: 100,
          orderby: "count",
          order: "desc",
          _fields: "id,name,slug,count",
        });

        const populated = categories.filter((category) => category.count > 0);

        if (populated.length === 0) {
          return asText("No categories with published posts.");
        }

        return asText(
          populated
            .map((category) => `${decodeEntities(category.name)} (${category.slug}) - ${category.count} posts`)
            .join("\n"),
        );
      } catch (error) {
        return asError(error);
      }
    },
  );

  return server;
}

const app = express();

app.use(
  cors({
    origin: "*",
    exposedHeaders: ["mcp-session-id", "mcp-protocol-version"],
    allowedHeaders: ["content-type", "mcp-session-id", "mcp-protocol-version", "accept"],
  }),
);
app.use(express.json({ limit: "1mb" }));

app.get("/", (_req, res) => {
  res.json({
    name: "mobileshalom-mcp",
    status: "ok",
    site: SITE_URL,
    endpoint: "/mcp",
    transport: "streamable-http",
  });
});

app.post("/mcp", async (req, res) => {
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

  res.on("close", () => {
    transport.close();
    server.close();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("MCP request failed:", error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

// Stateless mode: no session to resume or terminate.
const methodNotAllowed = (_req, res) =>
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed." },
    id: null,
  });

app.get("/mcp", methodNotAllowed);
app.delete("/mcp", methodNotAllowed);

app.listen(PORT, "0.0.0.0", () => {
  console.log(`mobileshalom-mcp listening on port ${PORT}`);
});
