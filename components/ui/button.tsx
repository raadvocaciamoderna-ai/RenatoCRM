import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

/**
 * Button — hierarquia visual do RenaCrm.
 *
 * A cor forte fica reservada à ação principal. Ações secundárias ganham
 * superfície/borda suficientes para serem percebidas sem transformar toda a
 * interface em blocos coloridos. O modo escuro usa os mesmos neutros do Inbox:
 * #111b21 / #202c33 / #2a3942, com verde #00a884 só onde há prioridade.
 */
const buttonVariants = cva(
  [
    "inline-flex items-center justify-center gap-2 whitespace-nowrap",
    "rounded-sm font-medium",
    "transition-[background-color,border-color,color,box-shadow,transform]",
    "duration-fast ease-out",
    "focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
    "disabled:pointer-events-none disabled:opacity-50",
    "[&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
    "active:translate-y-px",
  ].join(" "),
  {
    variants: {
      variant: {
        primary:
          "border border-transparent bg-[#007a66] text-white shadow-sm hover:bg-[#006453] hover:shadow-md dark:bg-[#00a884] dark:text-[#071b17] dark:hover:bg-[#14b894]",
        default:
          "border border-transparent bg-[#007a66] text-white shadow-sm hover:bg-[#006453] hover:shadow-md dark:bg-[#00a884] dark:text-[#071b17] dark:hover:bg-[#14b894]",
        secondary:
          "border border-border-strong bg-surface-elevated text-text shadow-xs hover:border-accent hover:bg-accent-soft hover:text-accent dark:border-[#3b4a54] dark:bg-[#202c33] dark:text-[#e9edef] dark:hover:border-[#54656f] dark:hover:bg-[#2a3942] dark:hover:text-[#e9edef]",
        outline:
          "border border-border-strong bg-surface text-text shadow-xs hover:border-accent hover:bg-accent-soft hover:text-accent dark:border-[#3b4a54] dark:bg-[#111b21] dark:text-[#e9edef] dark:hover:border-[#54656f] dark:hover:bg-[#202c33] dark:hover:text-[#e9edef]",
        ghost:
          "border border-transparent bg-transparent text-text hover:bg-accent-soft hover:text-accent dark:text-[#d1d7db] dark:hover:bg-[#202c33] dark:hover:text-[#e9edef]",
        destructive:
          "border border-error bg-error text-white shadow-sm hover:brightness-95 hover:shadow-md",
        link:
          "bg-transparent text-accent underline underline-offset-4 decoration-1 hover:decoration-2 h-auto p-0",
      },
      // Alturas de toque: abaixo de `lg` (mesmo corte que o resto da casca
      // usa pra decidir "é celular/tablet, é mouse") toda variante bate os
      // 44px recomendados pra alvo de toque; de `lg:` pra cima, onde quem
      // aciona é cursor, volta pro tamanho compacto original — mudar isso
      // globalmente pro app inteiro em telas grandes infla a densidade sem
      // necessidade nenhuma. `lg` já nascia com 44px e não precisou mudar.
      size: {
        sm: "h-11 px-3 text-xs lg:h-8",
        default: "h-11 px-4 text-sm lg:h-9",
        md: "h-11 px-4 text-sm lg:h-9",
        lg: "h-11 px-6 text-sm",
        icon: "h-11 w-11 lg:h-9 lg:w-9",
      },
    },
    defaultVariants: {
      variant: "primary",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    );
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
