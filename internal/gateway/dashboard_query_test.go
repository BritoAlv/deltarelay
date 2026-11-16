package gateway

import (
	"net/http/httptest"
	"testing"
)

func TestDashboardRangeValidation(t *testing.T) {
	for _, query := range []string{
		"start=0&end=1000&bucket=0",
		"start=1000&end=1000&bucket=1",
		"start=0&end=1000&bucket=1",
		"start=0&end=1000&bucket=1001",
		"start=-1&end=1000&bucket=100",
		"start=0&end=1000&bucket=100&host=../private",
		"start=0&end=8640000000000000&bucket=8640000000000000",
		"start=0&end=1000&bucket=100&now=invalid",
		"start=1",
	} {
		request := httptest.NewRequest("GET", "/dashboard?compact=1&"+query, nil)
		if _, err := dashboardRange(request); err == nil {
			t.Errorf("accepted invalid range: %s", query)
		}
	}
	query, err := dashboardRange(httptest.NewRequest("GET", "/dashboard?compact=1&start=0&end=200&bucket=1&host=alpha&exact=1&now=200", nil))
	if err != nil || query.Start.UnixMilli() != 0 || query.End.UnixMilli() != 200 || query.Host != "alpha" || !query.Exact || query.Now.UnixMilli() != 200 {
		t.Fatalf("valid range rejected: %+v %v", query, err)
	}
}
