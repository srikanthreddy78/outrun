import NextAuth from "next-auth";
import GitHub from "next-auth/providers/github";
import { verifiedAllowedGithubEmail } from "./lib/team-access";

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [GitHub({ authorization: { params: { scope: "read:user user:email" } } })],
  session: { strategy: "jwt" },
  callbacks: {
    async signIn({ account, user }) {
      if (account?.provider !== "github") return false;
      const email = await verifiedAllowedGithubEmail(
        account.access_token,
        process.env.AUTH_GITHUB_ALLOWLIST ?? "",
      );
      if (!email) return false;
      user.email = email;
      return true;
    },
    async jwt({ token, user }) {
      if (user?.email) token.email = user.email;
      return token;
    },
    async session({ session, token }) {
      if (session.user) session.user.email = typeof token.email === "string" ? token.email : "";
      return session;
    },
  },
});
