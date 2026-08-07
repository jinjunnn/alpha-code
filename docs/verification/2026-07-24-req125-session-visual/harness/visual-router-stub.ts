export function useNavigate() {
  return (..._args: unknown[]) => {}
}

export function useLocation() {
  return {
    pathname: location.pathname,
    search: location.search,
    hash: location.hash,
    query: {},
    state: undefined,
    key: "req125-visual",
  }
}
