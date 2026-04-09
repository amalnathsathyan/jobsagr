import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
    console.error("Missing Supabase credentials in .env");
    process.exit(1);
}

const supabase = createClient(url, key);

async function checkTable() {
    console.log("Checking Supabase connection and 'jobs' table...");
    const { data, error } = await supabase.from('jobs').select('count', { count: 'exact', head: true });
    
    if (error) {
        console.error("Error connecting to Supabase or 'jobs' table missing:", error.message);
        console.log("\nSuggested action: Run the SQL in db/supabase_schema.sql in your Supabase SQL Editor.");
    } else {
        console.log("Success! 'jobs' table exists. Current row count:", data || 0);
    }
}

checkTable();
