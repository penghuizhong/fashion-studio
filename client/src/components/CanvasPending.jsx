import { BaseBoxShapeUtil, HTMLContainer, Rectangle2d, T } from 'tldraw';
export class CanvasPendingUtil extends BaseBoxShapeUtil {
  static type = 'canvas-pending';
  static props = {w:T.number,h:T.number,label:T.string,state:T.string};
  getDefaultProps(){return {w:320,h:400,label:'生成中…',state:'running'};}
  getGeometry(shape){return new Rectangle2d({width:shape.props.w,height:shape.props.h,isFilled:true});}
  canResize(){return false;}
  canEdit(){return false;}
  component(shape){return <HTMLContainer className={`canvas-pending ${shape.props.state}`}><span>{shape.props.state==='running'?'◌':'!'} {shape.props.label}</span></HTMLContainer>;}
  indicator(shape){return <rect width={shape.props.w} height={shape.props.h}/>;}
}
export const canvasShapeUtils=[CanvasPendingUtil];
