import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

    if (!supabaseUrl || !supabaseKey) {
        return res.status(500).json({ error: 'Missing Supabase configuration' });
    }

    const supabase = createClient(supabaseUrl, supabaseKey);

    try {
        const { data: teams, error } = await supabase
            .from('teams')
            .select('*')
            .order('first_detected', { ascending: false });

        if (error) {
            throw error;
        }

        return res.status(200).json({
            success: true,
            count: teams?.length || 0,
            teams: teams || []
        });

    } catch (error) {
        console.error('Fetch teams error:', error);
        return res.status(500).json({ error: 'Failed to fetch teams', details: error.message });
    }
}
