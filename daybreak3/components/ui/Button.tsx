"use client";

import { motion } from "framer-motion";

interface ButtonProps {
  onClick?: () => void;
  children: React.ReactNode;
  variant?: "primary" | "ghost";
  type?: "button" | "submit";
}

export function Button({ onClick, children, variant = "primary", type = "button" }: ButtonProps) {
  if (variant === "ghost") {
    return (
      <motion.button
        type={type}
        onClick={onClick}
        whileTap={{ scale: 0.97 }}
        className="text-[#4A3728] text-sm font-[Inter] tracking-wide opacity-60 hover:opacity-100 transition-opacity cursor-pointer"
      >
        {children}
      </motion.button>
    );
  }

  return (
    <motion.button
      type={type}
      onClick={onClick}
      whileTap={{ scale: 0.97 }}
      whileHover={{ opacity: 0.85 }}
      className="px-8 py-3 rounded-full border border-[#2A1F18]/20 text-[#2A1F18] text-sm font-[Inter] font-medium tracking-wide bg-[#2A1F18]/5 hover:bg-[#2A1F18]/10 transition-colors cursor-pointer"
    >
      {children}
    </motion.button>
  );
}
