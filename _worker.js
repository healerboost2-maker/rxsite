export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        const path = url.pathname;
        const method = request.method.toUpperCase();

        /*
         * ============================================================
         * ALLOWED WEBSOCKET ENDPOINTS
         * ============================================================
         */

        if (path === "/amrx" || path === "/fmrx") {
            const upgrade = request.headers.get("Upgrade");

            /*
             * A normal browser visit to /amrx or /fmrx is NOT allowed.
             * Only a real WebSocket upgrade can use these endpoints.
             */
            if (
                method !== "GET" ||
                !upgrade ||
                upgrade.toLowerCase() !== "websocket"
            ) {
                return forbiddenPage();
            }

            const upstream =
                path === "/amrx"
                    ? "https://amfm-live.up.railway.app/amrx"
                    : "https://amfm-live.up.railway.app/fmrx";

            /*
             * Transparent WebSocket proxy.
             */
            return fetch(upstream, {
                method: "GET",
                headers: {
                    "Upgrade": "websocket"
                }
            });
        }


        /*
         * ============================================================
         * ALLOWED JAVASCRIPT MODULES
         * ============================================================
         */

        const allowedModules = new Set([
            "/modules/radio-core.js",
            "/modules/am.js",
            "/modules/fm.js"
        ]);

        if (allowedModules.has(path)) {
            const destination =
                request.headers.get("Sec-Fetch-Dest");

            const mode =
                request.headers.get("Sec-Fetch-Mode");

            /*
             * Only permit these files when requested as JavaScript
             * modules by the browser.
             */
            if (
                method !== "GET" ||
                destination !== "script" ||
                mode === "navigate"
            ) {
                return forbiddenPage();
            }

            return env.ASSETS.fetch(request);
        }


        /*
         * ============================================================
         * ALLOWED STATIC FILES
         * ============================================================
         */

        const allowedFiles = new Set([
            "/",
            "/index.html",

            "/favicon.ico",

            "/assets/gma_logo.webp",
            "/assets/notif_am.png",
            "/assets/notif_fm.png",
            "/assets/broadcast_signal.svg"
        ]);

        if (allowedFiles.has(path)) {
            return env.ASSETS.fetch(request);
        }


        /*
         * ============================================================
         * EVERYTHING ELSE = FORBIDDEN
         * ============================================================
         *
         * There is deliberately NO blacklist here.
         *
         * Any unknown path is blocked automatically.
         */

        return forbiddenPage();
    }
};


/*
 * ================================================================
 * FORBIDDEN PAGE
 * ================================================================
 *
 * This is generated directly by the Worker.
 * It does NOT depend on forbidden.html.
 */

function forbiddenPage() {
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">

    <meta
        name="viewport"
        content="width=device-width, initial-scale=1.0"
    >

    <title>GMA Radio</title>

    <meta
        name="robots"
        content="noindex,nofollow,noarchive"
    >

    <style>
        html,
        body {
            width: 100%;
            height: 100%;
            margin: 0;
            padding: 0;
            background: #0b0b0b;
            color: #ffffff;
            font-family:
                Arial,
                Helvetica,
                sans-serif;
        }

        body {
            display: flex;
            align-items: center;
            justify-content: center;
            text-align: center;
        }

        .box {
            width: min(90%, 420px);
            padding: 32px;
            box-sizing: border-box;
        }

        .title {
            margin: 0 0 10px;
            font-size: 24px;
            font-weight: 700;
        }

        .message {
            margin: 0;
            color: #999999;
            font-size: 14px;
        }
    </style>
</head>

<body>

    <main class="box">
        <div class="title">
            Page unavailable
        </div>

        <div class="message">
            Returning to GMA Radio...
        </div>
    </main>

    <script>
        setTimeout(function () {
            window.location.replace("/");
        }, 1200);
    </script>

</body>
</html>`;

    return new Response(html, {
        status: 403,

        headers: {
            "Content-Type":
                "text/html; charset=UTF-8",

            "Cache-Control":
                "no-store, no-cache, must-revalidate, max-age=0",

            "Pragma":
                "no-cache",

            "X-Content-Type-Options":
                "nosniff",

            "X-Robots-Tag":
                "noindex, nofollow, noarchive"
        }
    });
}