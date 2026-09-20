import cors from "cors";
import express from "express";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const SITE_NAME = "mobileShalom";
const SITE_URL = (process.env.SITE_URL || "https://mobileshalom.com").replace(/\/+$/, "");
const WP_API = `${SITE_URL}/wp-json/wp/v2`;
const UPSTREAM_TIMEOUT_MS = 10_000;
const PAGE_SIZE = 100;
const MAX_PAGES = 5;

const PORT = Number.parseInt(process.env.PORT ?? "3000", 10);
if (!Number.isInteger(PORT) || PORT < 0 || PORT > 65535) {
  console.error(`Invalid PORT: ${JSON.stringify(process.env.PORT)}`);
  process.exit(1);
}

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

const MAX_CODE_POINT = 0x10ffff;

// Decoding happens in a single pass so a decoded "&" cannot combine with the
// text after it into a second entity: "&#38;lt;" is an author showing "&lt;"
// as visible text, and must not end up as "<".
function decodeEntities(value = "") {
  return value.replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (match, body) => {
    if (!body.startsWith("#")) {
      return NAMED_ENTITIES[`&${body.toLowerCase()};`] ?? match;
    }

    const hex = body[1] === "x" || body[1] === "X";
    const code = hex ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);

    // Out of range or a lone surrogate: leave it as written rather than let
    // String.fromCodePoint throw and take the whole article down with it.
    if (!Number.isInteger(code) || code < 0 || code > MAX_CODE_POINT) return match;
    if (code >= 0xd800 && code <= 0xdfff) return match;

    return String.fromCodePoint(code);
  });
}

// Attribute values can contain ">", as in <img alt="a > b">, so quoted runs
// are consumed whole instead of stopping at the first ">".
const HTML_TAG = /<[^>'"]*(?:(?:"[^"]*"|'[^']*')[^>'"]*)*>/g;

function toPlainText(html = "") {
  const stripped = html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|blockquote)>/gi, "\n")
    .replace(HTML_TAG, "");

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

// WordPress caps per_page at 100, so anything that should return "all of them"
// has to walk the pages.
async function wpFetchAll(resource, params = {}) {
  const all = [];

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    let batch;
    try {
      batch = await wpFetch(resource, { ...params, per_page: PAGE_SIZE, page });
    } catch (error) {
      if (page === 1) throw error;
      break; // WordPress errors on a page past the last one.
    }

    all.push(...batch);
    if (batch.length < PAGE_SIZE) break;
  }

  return all;
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

// One unreadable post should cost the reader that post, not the whole listing.
function formatPostList(posts) {
  return posts
    .map((post) => {
      try {
        return formatPostSummary(post);
      } catch {
        return `Slug: ${post?.slug ?? "unknown"}\nLink: ${post?.link ?? ""}\n(This post could not be rendered.)`;
      }
    })
    .join("\n\n");
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
          _fields: "slug,title,date,link,excerpt",
        });

        if (posts.length === 0) {
          return asText(`No posts found for "${query}".`);
        }

        return asText(formatPostList(posts));
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
          _fields: "slug,title,date,link,excerpt",
        });

        if (posts.length === 0) {
          return asText("No posts published yet.");
        }

        return asText(formatPostList(posts));
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

        const fields = "slug,title,date,link,content";
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
        const categories = await wpFetchAll("categories", {
          orderby: "count",
          order: "desc",
          _fields: "name,slug,count",
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
    // Fires on every request, including client disconnects; a rejection here
    // must not become an unhandled rejection.
    Promise.allSettled([transport.close(), server.close()]);
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
  res.status(405).set("Allow", "POST").json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed." },
    id: null,
  });

app.get("/mcp", methodNotAllowed);
app.delete("/mcp", methodNotAllowed);

// Without this, a malformed body reaches Express's default handler, which
// answers a public caller with an HTML page containing a stack trace.
app.use((error, _req, res, next) => {
  if (res.headersSent) return next(error);

  const status = error.status ?? error.statusCode ?? 500;
  const [code, message] =
    status === 400
      ? [-32700, "Invalid JSON in request body."]
      : status === 413
        ? [-32600, "Request body too large."]
        : [-32603, "Internal server error."];

  console.error(`Request rejected (${status}): ${error.message}`);
  res.status(status).json({ jsonrpc: "2.0", error: { code, message }, id: null });
});

const httpServer = app.listen(PORT, "0.0.0.0", () => {
  console.log(`mobileshalom-mcp listening on port ${httpServer.address().port}`);
});

// Hosts send SIGTERM on redeploy; finish in-flight requests rather than
// cutting their responses mid-stream.
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10_000).unref();
  });
}
