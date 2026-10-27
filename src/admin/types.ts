/** The logged-in admin attached to each request by requireAdmin. */
export interface AdminUser {
  user_id: string; // BIGINT comes back from pg as a string
  name: string;
  roles: string[];
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AdminUser;
    }
  }
}
