import type { Metadata } from "next";
import { Inter, Ubuntu } from "next/font/google";
import "./globals.css";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  display: "swap",
});

const ubuntu = Ubuntu({
  weight: ["400", "500", "700"],
  variable: "--font-ubuntu",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "JobsAgr — AI-Powered Web3 Job Discovery",
  description:
    "Autonomous job discovery portal powered by ElizaOS agents on Nosana decentralized compute. Jobs are scraped from company X profiles in real-time.",
  keywords: ["web3 jobs", "crypto careers", "decentralized AI", "ElizaOS", "Nosana"],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${inter.variable} ${ubuntu.variable} antialiased`}>
      <body className="min-h-screen flex flex-col">{children}</body>
    </html>
  );
}
