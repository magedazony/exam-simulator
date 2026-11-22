-- Accounts an administrator creates for someone to try the app, and the email
-- status in the user list (so an administrator can confirm an address when
-- the server sends no email).
CREATE OR REPLACE FUNCTION admin_find_users(p_query text) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'id', u.id, 'email', u.email, 'status', u.status, 'mfaEnabled', u.totp_enabled_at IS NOT NULL,
           'emailVerified', u.email_verified_at IS NOT NULL, 'createdAt', u.created_at,
           'roles', coalesce((SELECT jsonb_agg(r.code ORDER BY r.id) FROM user_roles ur JOIN roles r ON r.id = ur.role_id
                              WHERE ur.user_id = u.id), '[]'::jsonb)) ORDER BY u.email), '[]'::jsonb)
  FROM (SELECT * FROM users
        WHERE p_query = '' OR email ILIKE '%' || replace(replace(p_query, '%', ''), '_', '') || '%'
        ORDER BY email LIMIT 50) u;
$$;
