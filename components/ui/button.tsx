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
    "rounded-md font-semibold",
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
          "border border-[#006453] bg-[#007a66] text-white shadow-md hover:bg-[#006453] hover:shadow-lg dark:border-[#13b18f] dark:bg-[#00a884] dark:text-[#071b17] dark:hover:bg-[#19b997]",
        default:
          "border border-[#006453] bg-[#007a66] text-white shadow-md hover:bg-[#006453] hover:shadow-lg dark:border-[#13b18f] dark:bg-[#00a884] dark:text-[#071b17] dark:hover:bg-[#19b997]",
        secondary:
          "border border-[#b7c1c7] bg-[#e8edef] text-[#111b21] shadow-sm hover:border-[#007a66] hover:bg-[#dce7e4] hover:text-[#005c4b] dark:border-[#4a5b66] dark:bg-[#26363f] dark:text-[#e9edef] dark:hover:border-[#00a884] dark:hover:bg-[#30434d] dark:hover:text-white",
        outline:
          "border border-[#b7c1c7] bg-[#f7f9fa] text-[#1f2c33] shadow-sm hover:border-[#007a66] hover:bg-[#eaf4f1] hover:text-[#005c4b] dark:border-[#4a5b66] dark:bg-[#17242b] dark:text-[#e9edef] dark:hover:border-[#00a884] dark:hover:bg-[#202f37] dark:hover:text-white",
        ghost:
          "border border-transparent bg-transparent text-[#34444e] hover:bg-[#e8edef] hover:text-[#007a66] dark:text-[#d1d7db] dark:hover:bg-[#202c33] dark:hover:text-white",
        destructive:
          "border border-[#b83b45] bg-[#c44545] text-white shadow-md hover:bg-[#ad3841] hover:shadow-lg dark:border-[#ff7582] dark:bg-[#d94d5a] dark:hover:bg-[#e55c68]",
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
