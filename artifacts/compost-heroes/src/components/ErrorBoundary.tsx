import { Component, type ReactNode, type ErrorInfo } from "react";
import { Button } from "@/components/ui/button";
import { AlertCircle, RefreshCcw } from "lucide-react";

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  errorMessage: string;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, errorMessage: "" };
  }

  static getDerivedStateFromError(error: Error): State {
    return {
      hasError: true,
      errorMessage: error?.message ?? "Unknown error",
    };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[ErrorBoundary] Caught error:", error, info.componentStack);
  }

  handleReset = () => {
    this.setState({ hasError: false, errorMessage: "" });
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;

      return (
        <div className="min-h-screen bg-background flex flex-col items-center justify-center p-6 text-center">
          <div className="max-w-md space-y-4">
            <div className="flex justify-center">
              <div className="w-20 h-20 bg-destructive/10 rounded-full flex items-center justify-center ring-8 ring-destructive/5">
                <AlertCircle className="w-10 h-10 text-destructive" />
              </div>
            </div>
            <h2 className="text-2xl font-display font-bold text-foreground">
              Something went wrong
            </h2>
            <p className="text-muted-foreground text-sm leading-relaxed">
              The game hit an unexpected error. Your game session may have ended
              if the server restarted. Try refreshing or starting a new game.
            </p>
            {this.state.errorMessage && (
              <p className="text-xs text-muted-foreground/60 font-mono bg-muted rounded-lg px-3 py-2 text-left break-all">
                {this.state.errorMessage}
              </p>
            )}
            <div className="flex flex-col sm:flex-row gap-3 justify-center pt-2">
              <Button onClick={this.handleReset} variant="outline" className="gap-2">
                <RefreshCcw className="w-4 h-4" />
                Try Again
              </Button>
              <Button onClick={() => (window.location.href = "/")}>
                Back to Lobby
              </Button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
