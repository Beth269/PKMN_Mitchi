import { createClient } from "@supabase/supabase-js";

// Trage hier deine eigenen Werte aus Supabase -> Project Settings -> API ein.
const SUPABASE_URL = "https://lofvkzdyegtkrvwkgnkn.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxvZnZremR5ZWd0a3J2d2tnbmtuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODYxODgxNDQsImV4cCI6MjEwMTc2NDE0NH0.ovgO7yZLbnM1KzHIOcjSwnfUSi5L8QdM-X9DBewO3pk";

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
