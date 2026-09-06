/** Trusted SQL scopes select a bounded task page or a bound UUID list; owner and states stay parameters. */
export const taskDeliveryCountsSql = (taskScope: string, statesParameter: string) => `
  WITH latest AS (
    SELECT DISTINCT ON(task_id,CASE WHEN output_path LIKE 'workspace/%' THEN output_path ELSE 'workspace/' || COALESCE(output_path,id::text) END)
      task_id,status FROM provider_media_jobs WHERE user_id=$1 AND task_id IN (${taskScope})
    ORDER BY task_id,CASE WHEN output_path LIKE 'workspace/%' THEN output_path ELSE 'workspace/' || COALESCE(output_path,id::text) END,created_at DESC,id DESC
  )
  SELECT task_id,COUNT(*) FILTER(WHERE status=ANY(${statesParameter}::text[])) AS pending,
    COUNT(*) FILTER(WHERE status<>'completed' AND NOT(status=ANY(${statesParameter}::text[]))) AS failed
  FROM latest GROUP BY task_id`;
