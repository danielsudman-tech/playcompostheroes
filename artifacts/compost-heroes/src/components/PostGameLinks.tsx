import { ArrowUpRight } from "lucide-react";
import { POST_GAME_LINKS } from "@/lib/links";

export interface PostGameLinksProps {
  className?: string;
}

/** Small, optional next steps; safe to place beneath either kind of game result. */
export function PostGameLinks({ className = "" }: PostGameLinksProps) {
  return (
    <section aria-labelledby="post-game-links-title" className={`event-panel px-5 py-5 sm:px-7 sm:py-6 ${className}`}>
      <div className="mb-4">
        <p className="event-kicker">After the table</p>
        <h2 id="post-game-links-title" className="font-display text-2xl mt-1">Keep the conversation going.</h2>
      </div>
      <div className="divide-y divide-[#e4e8d9]">
        {POST_GAME_LINKS.map((link, index) => (
          <a
            key={link.id}
            href={link.href}
            target="_blank"
            rel="noopener noreferrer"
            data-testid={`link-post-game-${link.id}`}
            aria-label={`${link.label} (opens in a new tab)`}
            className="group flex items-center gap-4 py-3.5 first:pt-1 last:pb-0 rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#426c4a]"
          >
            <span aria-hidden="true" className="font-display text-xl text-[#a7b59c] w-7 shrink-0">0{index + 1}</span>
            <span className="flex-1 min-w-0">
              <span className="block text-sm font-extrabold text-[#304235] group-hover:text-[#426c4a]">{link.label}</span>
              <span className="block text-xs text-[#71826a] mt-0.5">{link.description}</span>
            </span>
            <span className="hidden sm:inline text-xs font-extrabold text-[#426c4a] shrink-0">{link.action}</span>
            <ArrowUpRight size={17} aria-hidden="true" className="shrink-0 text-[#668266] transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
          </a>
        ))}
      </div>
    </section>
  );
}

export default PostGameLinks;