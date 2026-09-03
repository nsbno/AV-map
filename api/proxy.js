const ALLOWED_HOSTS = new Set([
    'storage.googleapis.com',
    'nvdbapiles.atlas.vegvesen.no'
]);

const HOP_BY_HOP_HEADERS = new Set([
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade'
]);

module.exports = async function handler(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.status(405).json({ error: 'Only GET and HEAD are allowed.' });
        return;
    }

    const target = req.query?.url;
    if (!target) {
        res.status(400).json({ error: 'Missing "url" query parameter.' });
        return;
    }

    let targetUrl;
    try {
        targetUrl = new URL(target);
    } catch {
        res.status(400).json({ error: 'Invalid URL.' });
        return;
    }

    if (targetUrl.protocol !== 'https:' || !ALLOWED_HOSTS.has(targetUrl.hostname)) {
        res.status(403).json({ error: 'Target URL is not allowed.' });
        return;
    }

    try {
        const upstreamHeaders = {
            accept: req.headers.accept || '*/*'
        };
        if (req.headers['x-client']) upstreamHeaders['x-client'] = req.headers['x-client'];

        const upstreamResponse = await fetch(targetUrl.toString(), {
            method: req.method,
            headers: upstreamHeaders,
            redirect: 'follow'
        });

        res.status(upstreamResponse.status);
        upstreamResponse.headers.forEach((value, key) => {
            if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
                res.setHeader(key, value);
            }
        });
        res.setHeader('Access-Control-Allow-Origin', '*');

        if (req.method === 'HEAD') {
            res.end();
            return;
        }

        const body = Buffer.from(await upstreamResponse.arrayBuffer());
        res.send(body);
    } catch {
        res.status(502).json({ error: 'Failed to fetch upstream URL.' });
    }
};
