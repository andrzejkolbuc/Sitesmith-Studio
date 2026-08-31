import "~/styles/globals.css";

import type { Metadata } from "next";
import { IBM_Plex_Mono, IBM_Plex_Sans, IBM_Plex_Serif } from "next/font/google";

import { TRPCReactProvider } from "~/trpc/react";

export const metadata: Metadata = {
	title: "Sitesmith Studio",
	description: "Checks multilingual client sites before they go live.",
	icons: [{ rel: "icon", url: "/favicon.ico" }],
};

/**
 * One superfamily across three roles.
 *
 * Plex was drawn to hold a single voice across many languages and scripts,
 * which is the subject of this product. The mono is not decoration: locale tags
 * and URLs are the data this interface exists to show, and they have to align
 * down a column to be read as a set.
 */
const serif = IBM_Plex_Serif({
	subsets: ["latin"],
	weight: ["400", "600"],
	variable: "--font-plex-serif",
});

const sans = IBM_Plex_Sans({
	subsets: ["latin"],
	weight: ["400", "500", "600"],
	variable: "--font-plex-sans",
});

const mono = IBM_Plex_Mono({
	subsets: ["latin"],
	weight: ["400", "500"],
	variable: "--font-plex-mono",
});

export default function RootLayout({
	children,
}: Readonly<{ children: React.ReactNode }>) {
	return (
		<html
			className={`${serif.variable} ${sans.variable} ${mono.variable}`}
			lang="en"
		>
			<body className="bg-paper text-ink">
				<TRPCReactProvider>{children}</TRPCReactProvider>
			</body>
		</html>
	);
}
