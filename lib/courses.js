import { getSupabase } from "./supabase.js";

export async function searchCourses(queryEmbedding, k = 15) {
  const supabase = getSupabase();
  const { data, error } = await supabase.rpc("match_courses", {
    query_embedding: queryEmbedding,
    match_count: k,
  });
  if (error) throw new Error(`Supabase search failed: ${error.message}`);
  return data;
}
