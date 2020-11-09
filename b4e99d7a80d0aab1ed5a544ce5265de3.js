<h1 id='a1'>404</h1>
<style type="text/css">
body{
  overflow:hidden;
  background: #777;
}
#a1{
    display: inline-block;
    margin: 0;
    position: absolute;
    left: 0;
    top: 0;
}
</style>
<script type="text/javascript">
function r10() {
  return Math.random()*5+5
}
var dx=r10(), dy=r10(), vx=1, vy=1, dd=0
function run(){
  a1.style.left=a1.offsetLeft+dx*vx+'px'
  a1.style.top=a1.offsetTop+dy*vy+'px'
  var n=dx+dy
  if(a1.offsetLeft<1 || a1.offsetLeft>=innerWidth-a1.offsetWidth) dx=r10(), vx=a1.offsetLeft<1?1:-1
  if(a1.offsetTop<1 || a1.offsetTop>=innerHeight-a1.offsetHeight) dy=r10(), vy=a1.offsetTop<1?1:-1
  a1.style.transform='rotate('+(dd=(dd+5*vx*vy)%360)+'deg)'
  setTimeout(run, (a1.style.color=n===dx+dy?'#000':'red')==='red'?50:16)
}
run()
</script>