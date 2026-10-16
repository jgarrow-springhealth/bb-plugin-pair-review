// Shared controls for the Pair Review page, built on BB's registry
// primitives so they match the rest of the host and its plugins.
import type { ComponentProps, ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export { TooltipProvider };

/** A hover/focus hint for any control whose purpose isn't spelled out. */
export function Hint({
  label,
  disabled = false,
  children,
}: {
  label: ReactNode;
  /**
   * Disabled buttons fire no pointer events, so their hint attaches to a
   * wrapper instead; it still explains why nothing happens.
   */
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {disabled ? (
          <span className="inline-flex" data-hint-wrapper="">
            {children}
          </span>
        ) : (
          children
        )}
      </TooltipTrigger>
      <TooltipContent side="top">{label}</TooltipContent>
    </Tooltip>
  );
}

/** An icon-only button: its label is both its accessible name and its tooltip. */
export function IconAction({
  icon,
  label,
  disabled,
  ...props
}: Omit<ComponentProps<typeof Button>, "children"> & {
  icon: string;
  label: string;
}) {
  return (
    <Hint label={label} disabled={!!disabled}>
      <Button
        variant="ghost"
        size="icon"
        className="size-8 text-muted-foreground hover:text-foreground"
        aria-label={label}
        disabled={disabled}
        {...props}
      >
        <Icon name={icon} className="size-4" />
      </Button>
    </Hint>
  );
}

export interface PickerOption {
  value: string;
  label: string;
}

/**
 * A styled single-choice dropdown in place of a native <select>. Values must
 * be non-empty strings; an empty `value` shows the placeholder.
 */
export function Picker({
  label,
  value,
  onChange,
  options,
  placeholder,
  disabled = false,
  mono = false,
  className,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: readonly PickerOption[];
  placeholder?: string;
  disabled?: boolean;
  /** Code-like option text, such as file paths. */
  mono?: boolean;
  className?: string;
}) {
  return (
    <Select
      value={value || undefined}
      onValueChange={onChange}
      disabled={disabled || !options.length}
    >
      <SelectTrigger
        aria-label={label}
        className={cn(
          "pr-picker h-8 w-auto min-w-0 max-w-full gap-3 rounded-md border border-input bg-background px-3 text-[13px] text-foreground hover:bg-state-hover focus:outline-none focus:ring-1 focus:ring-ring [&>span]:min-w-0 [&>span]:truncate [&>span]:text-left",
          mono && "font-mono text-xs",
          className,
        )}
      >
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent
        position="popper"
        sideOffset={4}
        align="start"
        className="max-h-[min(60vh,360px)] max-w-[min(calc(100vw-2rem),640px)]"
      >
        {options.map((option) => (
          <SelectItem
            key={option.value}
            value={option.value}
            className={cn(
              "rounded-md py-1.5 pl-2.5 text-[13px] data-[state=checked]:font-medium",
              mono && "font-mono text-xs",
            )}
          >
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
