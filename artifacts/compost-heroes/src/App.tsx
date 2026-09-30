import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import Lobby from "./pages/Lobby";
import Game from "./pages/Game";
import FacilitatedGame from "./pages/FacilitatedGame";
import FacilitatorDashboard from "./pages/FacilitatorDashboard";
import FacilitatorHome from "./pages/FacilitatorHome";
import EventControl from "./pages/EventControl";
import EventLobby from "./pages/EventLobby";
import EventGathering from "./pages/EventGathering";
import Admin from "./pages/Admin";
import { AppGate } from "./components/AppGate";
import { ErrorBoundary } from "./components/ErrorBoundary";

const queryClient = new QueryClient();

function GameRouter() {
  return (
    <Switch>
      <Route path="/" component={Lobby} />
      <Route path="/facilitator" component={FacilitatorHome} />
      <Route path="/facilitator/events/:eventId" component={EventControl} />
      <Route path="/event/:code/results" component={EventGathering} />
      <Route path="/event/:code" component={EventLobby} />
      <Route path="/game/:gameId" component={Game} />
      <Route path="/game/:gameId/table" component={FacilitatedGame} />
      <Route path="/game/:gameId/host" component={FacilitatorDashboard} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
            <ErrorBoundary>
              <Switch>
                <Route path="/admin" component={Admin} />
                <Route>
                  <AppGate>
                    <GameRouter />
                  </AppGate>
                </Route>
              </Switch>
            </ErrorBoundary>
          </WouterRouter>
          <Toaster />
        </TooltipProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}

export default App;
