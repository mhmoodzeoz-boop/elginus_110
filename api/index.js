// api/index.js
const GITHUB_API = (owner, repo, path) => `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();

    const token = process.env.GITHUB_TOKEN;
    const owner = process.env.GITHUB_OWNER;
    const repo = process.env.GITHUB_REPO;
    const branch = process.env.GITHUB_BRANCH || 'main';
    const defaultPass = process.env.ADMIN_PASSWORD || 'mklopmklop';

    if (!token || !owner || !repo) return res.status(500).json({ error: 'Missing Env Vars' });

    const dbUrl = `${GITHUB_API(owner, repo, 'db.json')}?ref=${branch}`;

    async function getDB() {
        const getRes = await fetch(dbUrl, {
            headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'Vercel-App' }
        });
        if (!getRes.ok) throw new Error('GitHub read failed');
        const fileData = await getRes.json();
        const db = JSON.parse(Buffer.from(fileData.content, 'base64').toString('utf-8'));
        if (!db.products) db.products = {};
        if (!db.categories) db.categories = ["Laptops", "Mouse", "Accessories", "Other"];
        if (!db.settings) db.settings = { password: defaultPass };
        if (!db.activity) db.activity = [];
        return { db, sha: fileData.sha };
    }

    async function updateDB(db, sha, message) {
        const updateRes = await fetch(GITHUB_API(owner, repo, 'db.json'), {
            method: 'PUT',
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json',
                'User-Agent': 'Vercel-App'
            },
            body: JSON.stringify({
                message: message,
                content: Buffer.from(JSON.stringify(db, null, 2)).toString('base64'),
                sha: sha,
                branch: branch
            })
        });
        if (!updateRes.ok) throw new Error('GitHub write failed');
    }

    async function uploadFileToGitHub(fileName, base64Content) {
        const filePath = `files/${Date.now()}-${fileName}`;
        const uploadUrl = GITHUB_API(owner, repo, filePath);
        const uploadRes = await fetch(uploadUrl, {
            method: 'PUT',
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json',
                'User-Agent': 'Vercel-App'
            },
            body: JSON.stringify({
                message: `Upload file: ${fileName}`,
                content: base64Content,
                branch: branch
            })
        });
        if (!uploadRes.ok) throw new Error('Failed to upload file');
        return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${filePath}`;
    }

    function logActivity(db, description) {
        if (!db.activity) db.activity = [];
        db.activity.unshift({ timestamp: new Date().toISOString(), description });
        if (db.activity.length > 100) db.activity = db.activity.slice(0, 100);
    }

    // === GET ===
    if (req.method === 'GET') {
        try {
            if (req.query.action === 'get-products') {
                const { db } = await getDB();
                return res.status(200).json({ products: Object.values(db.products) });
            }
            if (req.query.action === 'get-categories') {
                const { db } = await getDB();
                return res.status(200).json({ categories: db.categories });
            }
            if (req.query.action === 'get-theme') {
                const { db } = await getDB();
                return res.status(200).json({ theme: db.settings.theme || null });
            }
        } catch (error) {
            return res.status(500).json({ error: 'Internal server error: ' + error.message });
        }
    }

    // === POST ===
    if (req.method === 'POST') {
        const { action, adminPassword } = req.body;
        try {
            const { db, sha } = await getDB();
            const storedPass = db.settings?.password || defaultPass;

            if (action === 'login') {
                if (adminPassword === storedPass) return res.status(200).json({ success: true });
                return res.status(401).json({ error: 'Unauthorized' });
            }

            if (adminPassword !== storedPass) return res.status(401).json({ error: 'Unauthorized' });

            // Add/Edit Product
            if (action === 'add-product' || action === 'edit-product') {
                const { name, description, price, category, imageUrl, imageData, imageName, productId } = req.body;
                if (!name || !price) return res.status(400).json({ error: 'Name and Price required' });

                let finalImageUrl = imageUrl;
                if (imageData && imageName) finalImageUrl = await uploadFileToGitHub(imageName, imageData);

                if (action === 'add-product') {
                    const id = Date.now().toString(36) + Math.random().toString(36).substring(2, 6);
                    db.products[id] = { id, name, description, price: parseFloat(price), category, imageUrl: finalImageUrl || '', createdAt: new Date().toISOString() };
                    logActivity(db, `Added: ${name}`);
                    await updateDB(db, sha, `Add: ${name}`);
                    return res.status(200).json({ success: true, productId: id });
                } else {
                    if (!db.products[productId]) return res.status(404).json({ error: 'Not found' });
                    db.products[productId] = { ...db.products[productId], name, description, price: parseFloat(price), category, imageUrl: finalImageUrl };
                    logActivity(db, `Edited: ${name}`);
                    await updateDB(db, sha, `Edit: ${name}`);
                    return res.status(200).json({ success: true });
                }
            }

            // Delete Product
            if (action === 'delete-product') {
                const { productId } = req.body;
                if (!db.products[productId]) return res.status(404).json({ error: 'Not found' });
                const name = db.products[productId].name;
                delete db.products[productId];
                logActivity(db, `Deleted: ${name}`);
                await updateDB(db, sha, `Delete: ${name}`);
                return res.status(200).json({ success: true });
            }

            // Add Category
            if (action === 'add-category') {
                const { category } = req.body;
                if (!category) return res.status(400).json({ error: 'Category required' });
                if (!db.categories.includes(category)) db.categories.push(category);
                logActivity(db, `Added category: ${category}`);
                await updateDB(db, sha, `Category: ${category}`);
                return res.status(200).json({ success: true });
            }

            // Delete Category
            if (action === 'delete-category') {
                const { category } = req.body;
                db.categories = db.categories.filter(c => c !== category);
                logActivity(db, `Deleted category: ${category}`);
                await updateDB(db, sha, `Del Cat: ${category}`);
                return res.status(200).json({ success: true });
            }

            // Change Password
            if (action === 'change-password') {
                const { newPassword } = req.body;
                if (!newPassword || newPassword.length < 4) return res.status(400).json({ error: 'Too short' });
                db.settings.password = newPassword;
                logActivity(db, `Password changed`);
                await updateDB(db, sha, `Password changed`);
                return res.status(200).json({ success: true });
            }

            // Change Theme
            if (action === 'change-theme') {
                const { theme } = req.body; // { gold, red, bg }
                db.settings.theme = theme;
                logActivity(db, `Theme updated`);
                await updateDB(db, sha, `Theme updated`);
                return res.status(200).json({ success: true });
            }
        } catch (error) {
            return res.status(500).json({ error: 'Internal server error: ' + error.message });
        }
    }

    return res.status(405).json({ error: 'Method not allowed' });
}
