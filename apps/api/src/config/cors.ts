/** Keep the existing exact-origin/credential/header policy; declare the HTTP
 * verbs actually used by our controllers instead of Fastify's GET/HEAD/POST
 * default. CORS never grants authentication or resource permissions. */
export function apiCorsOptions(configuredOrigins: string) {
  return {
    origin: configuredOrigins.split(",").map((item) => item.trim()),
    credentials: true,
    methods: ["GET", "HEAD", "POST", "PATCH", "PUT", "DELETE"],
  };
}
